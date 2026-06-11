// process-runner — host side of the connector runner process.
//
// RunnerSession is the supervisor's uniform surface for executing trusted
// connector code. ProcessRunnerSession spawns a Bun child per session and
// brokers every capability call over IPC, so connector code never shares the
// core process: a crash, busy loop, or ignored AbortSignal is contained and
// force-killable. InProcessRunnerSession serves manually registered
// definitions (tests, embedding) with the same semantics in-process.

import { fileURLToPath } from "url";
import type {
  ConnectorDefinition,
  ConnectorHostContext,
  ConnectorRequirementContext,
  ConnectorRequirementStatus,
} from "./types";
import type { HostToRunnerMessage, RunnerToHostMessage } from "./runner-protocol";

export interface RunnerCapabilities {
  authType: string;
  writeEvent(event: unknown): Promise<unknown>;
  writeEvents(events: unknown): Promise<unknown>;
  stateGet(): Promise<unknown>;
  stateSet(value: unknown): Promise<void>;
  authGetToken(): Promise<string>;
}

export interface RunnerRunOptions {
  config: unknown;
  host: ConnectorHostContext;
  signal: AbortSignal;
  capabilities: RunnerCapabilities;
}

export interface RunnerSession {
  requirementIds(): string[];
  check(
    ids: string[],
    ctx: ConnectorRequirementContext,
  ): Promise<Record<string, ConnectorRequirementStatus | null>>;
  request(id: string, ctx: ConnectorRequirementContext): Promise<ConnectorRequirementStatus | null>;
  run(opts: RunnerRunOptions): Promise<void>;
  close(): Promise<void>;
}

// ── In-process session (manually registered definitions) ───────────────

export class InProcessRunnerSession implements RunnerSession {
  constructor(private definition: ConnectorDefinition) {}

  requirementIds(): string[] {
    return Object.keys(this.definition.requirements ?? {});
  }

  async check(
    ids: string[],
    ctx: ConnectorRequirementContext,
  ): Promise<Record<string, ConnectorRequirementStatus | null>> {
    const records: Record<string, ConnectorRequirementStatus | null> = {};
    for (const id of ids) {
      const handler = this.definition.requirements?.[id];
      if (!handler) {
        records[id] = null;
        continue;
      }
      try {
        records[id] = await handler.check(ctx);
      } catch (err) {
        records[id] = { status: "error", message: errorMessage(err) };
      }
    }
    return records;
  }

  async request(
    id: string,
    ctx: ConnectorRequirementContext,
  ): Promise<ConnectorRequirementStatus | null> {
    const handler = this.definition.requirements?.[id];
    if (!handler) return null;
    try {
      return handler.request ? await handler.request(ctx) : await handler.check(ctx);
    } catch (err) {
      return { status: "error", message: errorMessage(err) };
    }
  }

  async run(opts: RunnerRunOptions): Promise<void> {
    const caps = opts.capabilities;
    await this.definition.run({
      guard: {
        writeEvent: (event) => caps.writeEvent(event) as Promise<{ id: string }>,
        writeEvents: (events) => caps.writeEvents(events) as Promise<{ ids: string[] }>,
      },
      state: {
        get: () => caps.stateGet(),
        set: (value) => caps.stateSet(value),
      },
      auth: caps.authType === "none"
        ? { type: "none" }
        : { type: caps.authType as "apiKey" | "oauth2", getToken: () => caps.authGetToken() },
      config: opts.config,
      host: opts.host,
      signal: opts.signal,
    });
  }

  async close(): Promise<void> {}
}

// ── Process session (workspace package connectors) ─────────────────────

const RUNNER_CHILD_PATH = fileURLToPath(new URL("./runner-child.ts", import.meta.url));
const DEFAULT_KILL_GRACE_MS = 3_000;

export interface ProcessRunnerSessionOptions {
  entryPath: string;
  contentHash: string;
  cwd: string;
  killGraceMs?: number;
}

interface PendingCommand {
  expect: Set<RunnerToHostMessage["type"]>;
  resolve(message: RunnerToHostMessage): void;
  reject(err: Error): void;
}

export class ProcessRunnerSession implements RunnerSession {
  private proc: ReturnType<typeof Bun.spawn> | undefined;
  private pending: PendingCommand | undefined;
  private capabilities: RunnerCapabilities | undefined;
  private reqIds: string[] = [];
  private exited = false;
  private killGraceMs: number;

  constructor(private opts: ProcessRunnerSessionOptions) {
    this.killGraceMs = opts.killGraceMs ?? DEFAULT_KILL_GRACE_MS;
  }

  async open(): Promise<void> {
    this.proc = Bun.spawn([process.execPath, "run", RUNNER_CHILD_PATH], {
      cwd: this.opts.cwd,
      stdio: ["ignore", "inherit", "inherit"],
      serialization: "json",
      ipc: (message) => {
        this.onMessage(message as RunnerToHostMessage);
      },
      onExit: (_proc, exitCode) => {
        this.exited = true;
        const pending = this.pending;
        this.pending = undefined;
        pending?.reject(new Error(`Connector runner exited unexpectedly (code ${exitCode ?? "unknown"})`));
      },
    });

    await this.command({ type: "hello-wait" } as never, ["hello"], { sendNothing: true });
    const loaded = await this.command(
      { type: "load", entryPath: this.opts.entryPath, contentHash: this.opts.contentHash },
      ["loaded", "load-error"],
    );
    if (loaded.type === "load-error") {
      await this.close();
      throw new Error(loaded.message);
    }
    if (loaded.type === "loaded") {
      this.reqIds = loaded.requirementIds;
    }
  }

  requirementIds(): string[] {
    return this.reqIds;
  }

  async check(
    ids: string[],
    ctx: ConnectorRequirementContext,
  ): Promise<Record<string, ConnectorRequirementStatus | null>> {
    const reply = await this.command({ type: "check", ids, ctx }, ["checked"]);
    return reply.type === "checked" ? reply.records : {};
  }

  async request(
    id: string,
    ctx: ConnectorRequirementContext,
  ): Promise<ConnectorRequirementStatus | null> {
    const reply = await this.command({ type: "request", id, ctx }, ["requested"]);
    return reply.type === "requested" ? reply.status : null;
  }

  async run(opts: RunnerRunOptions): Promise<void> {
    this.capabilities = opts.capabilities;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    const onAbort = () => {
      this.send({ type: "abort" });
      // The abort is cooperative inside the child; the kill is not.
      killTimer = setTimeout(() => {
        this.proc?.kill();
      }, this.killGraceMs);
    };

    if (opts.signal.aborted) {
      onAbort();
    } else {
      opts.signal.addEventListener("abort", onAbort, { once: true });
    }

    try {
      const reply = await this.command(
        {
          type: "run",
          config: opts.config ?? null,
          host: { workspacePath: opts.host.workspacePath },
          authType: opts.capabilities.authType,
        },
        ["done", "run-error"],
      );
      if (reply.type === "run-error") {
        throw new Error(reply.message);
      }
    } catch (err) {
      // A kill after an ignored abort surfaces as an unexpected exit; treat it
      // as a completed abort rather than a connector failure.
      if (opts.signal.aborted) return;
      throw err;
    } finally {
      opts.signal.removeEventListener("abort", onAbort);
      clearTimeout(killTimer);
      this.capabilities = undefined;
    }
  }

  async close(): Promise<void> {
    const proc = this.proc;
    if (!proc) return;
    if (!this.exited) {
      proc.kill();
    }
    await proc.exited.catch(() => {});
  }

  private send(message: HostToRunnerMessage): void {
    this.proc?.send(message);
  }

  private command(
    message: HostToRunnerMessage,
    expect: Array<RunnerToHostMessage["type"]>,
    opts?: { sendNothing?: boolean },
  ): Promise<RunnerToHostMessage> {
    if (this.exited) {
      return Promise.reject(new Error("Connector runner process has exited"));
    }
    return new Promise<RunnerToHostMessage>((resolve, reject) => {
      this.pending = { expect: new Set(expect), resolve, reject };
      if (!opts?.sendNothing) {
        this.send(message);
      }
    });
  }

  private onMessage(message: RunnerToHostMessage): void {
    if (message.type === "rpc") {
      void this.dispatchRpc(message.id, message.method, message.params);
      return;
    }
    const pending = this.pending;
    if (pending && pending.expect.has(message.type)) {
      this.pending = undefined;
      pending.resolve(message);
    }
  }

  private async dispatchRpc(id: number, method: string, params: unknown): Promise<void> {
    const caps = this.capabilities;
    try {
      if (!caps) {
        throw new Error("Connector capability call outside an active run");
      }
      let value: unknown;
      switch (method) {
        case "writeEvent":
          value = await caps.writeEvent(params);
          break;
        case "writeEvents":
          value = await caps.writeEvents(params);
          break;
        case "stateGet":
          value = await caps.stateGet();
          break;
        case "stateSet":
          value = await caps.stateSet(params);
          break;
        case "authGetToken":
          value = await caps.authGetToken();
          break;
        default:
          throw new Error(`Unknown connector capability: ${method}`);
      }
      this.send({ type: "rpc-result", id, ok: true, value });
    } catch (err) {
      this.send({ type: "rpc-result", id, ok: false, error: errorMessage(err) });
    }
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
