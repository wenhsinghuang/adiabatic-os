import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { openDatabases } from "../src/db";
import { Guard } from "../src/guard";
import {
  ConnectorScheduler,
  ConnectorSupervisor,
  MemoryConnectorSecretStore,
  ConnectorAuthManager,
  installConnector,
  listInstalledConnectorDirs,
  installConnectorFromSource,
  isPlatformSupported,
  listAvailableBuiltIns,
  loadConnectorManifest,
  materializeBuiltInConnector,
  registerWorkspaceConnectors,
  removeInstalledConnector,
  resolveConnectorEntry,
  sourceForConnector,
  validateConnectorManifest,
  nextCronRunAt,
  type ConnectorDefinition,
  type ConnectorManifest,
} from "../src/connectors";

async function waitWithTestTimeout(promise: Promise<unknown>, timeoutMs: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise.then(() => true),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

describe("Connector system", () => {
  let workspace: string;
  let dataDb: ReturnType<typeof openDatabases>["dataDb"];
  let systemDb: ReturnType<typeof openDatabases>["systemDb"];
  let close: () => void;
  let supervisor: ConnectorSupervisor;
  let secrets: MemoryConnectorSecretStore;

  beforeEach(() => {
    workspace = mkdtempSync(join(tmpdir(), "adiabatic-connector-test-"));
    mkdirSync(join(workspace, ".adiabatic"), { recursive: true });
    const result = openDatabases(workspace);
    dataDb = result.dataDb;
    systemDb = result.systemDb;
    close = result.close;
    secrets = new MemoryConnectorSecretStore();
    supervisor = new ConnectorSupervisor({
      systemDb,
      guard: new Guard({ db: dataDb, source: "system:test" }),
      host: { workspacePath: workspace },
      platform: "darwin",
      authManager: new ConnectorAuthManager(secrets),
    });
  });

  afterEach(() => {
    close();
    rmSync(workspace, { recursive: true, force: true });
  });

  test("loads and validates a connector manifest from YAML", async () => {
    const dir = join(workspace, "connectors", "calendar");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "connector.yaml"),
      `id: calendar
name: Calendar
entry: ./index.mjs
runtime:
  mode: poll
  defaultSchedule: "*/15 * * * *"
integrations:
  mode: multiple
platforms:
  darwin:
    requirements:
      - macos-accessibility
  cloud: {}
auth:
  type: oauth2
  authorizationEndpoint: https://accounts.google.com/o/oauth2/v2/auth
  tokenEndpoint: https://oauth2.googleapis.com/token
  clientId: calendar-client-id
  scope:
    - https://www.googleapis.com/auth/calendar.readonly
`,
    );

    const manifest = await loadConnectorManifest(dir);
    expect(manifest).toMatchObject({
      id: "calendar",
      name: "Calendar",
      entry: "./index.mjs",
      runtime: { mode: "poll", defaultSchedule: "*/15 * * * *" },
      integrations: { mode: "multiple" },
      platforms: {
        darwin: { requirements: ["macos-accessibility"] },
        cloud: { requirements: [] },
      },
      auth: {
        type: "oauth2",
        authorizationEndpoint: "https://accounts.google.com/o/oauth2/v2/auth",
        tokenEndpoint: "https://oauth2.googleapis.com/token",
        clientId: "calendar-client-id",
        scope: ["https://www.googleapis.com/auth/calendar.readonly"],
      },
    });
  });

  test("rejects invalid manifest ids, modes, schedules, auth, and platforms", () => {
    const base: ConnectorManifest = {
      id: "demo",
      name: "Demo",
      entry: "./index.ts",
      runtime: { mode: "poll" },
      integrations: { mode: "singleton" },
    };

    expect(() => validateConnectorManifest({ ...base, id: "../demo" })).toThrow("Invalid connector id");
    expect(() =>
      validateConnectorManifest({ ...base, integrations: undefined as any })
    ).toThrow("requires an explicit integrations.mode");
    expect(() =>
      validateConnectorManifest({ ...base, runtime: { mode: "stream" as any } })
    ).toThrow("invalid runtime mode");
    expect(() =>
      validateConnectorManifest({ ...base, runtime: { mode: "watch", defaultSchedule: "every 1m" } })
    ).toThrow("defaultSchedule is only valid");
    expect(() =>
      validateConnectorManifest({ ...base, runtime: { mode: "poll", defaultSchedule: "every 1m" } })
    ).toThrow("Unsupported connector schedule");
    expect(() =>
      validateConnectorManifest({ ...base, runtime: { mode: "poll", schedule: "every 1m" } as any })
    ).toThrow("runtime.schedule is no longer supported");
    expect(() =>
      validateConnectorManifest({ ...base, platforms: ["darwin" as any] as any })
    ).toThrow("structured object");
    expect(() =>
      validateConnectorManifest({ ...base, platforms: { haiku: {} } as any })
    ).toThrow("invalid platform");
    expect(() =>
      validateConnectorManifest({ ...base, integrations: { mode: "many" as any } })
    ).toThrow("invalid integrations mode");
    expect(() =>
      validateConnectorManifest({ ...base, auth: { type: "oauth2", tokenEndpoint: "https://x/token" } as any })
    ).toThrow("requires authorizationEndpoint");
    expect(() =>
      validateConnectorManifest({
        ...base,
        auth: { type: "oauth2", authorizationEndpoint: {}, tokenEndpoint: "https://x/token" } as any,
      })
    ).toThrow("requires authorizationEndpoint");
    expect(() =>
      validateConnectorManifest({
        ...base,
        auth: { type: "oauth2", authorizationEndpoint: "http://x/auth", tokenEndpoint: "https://x/token" } as any,
      })
    ).toThrow("must be https");
    // clientId is optional (BYO): an oauth2 manifest without it is valid.
    expect(
      validateConnectorManifest({
        ...base,
        auth: { type: "oauth2", authorizationEndpoint: "https://x/auth", tokenEndpoint: "https://x/token" },
      }).auth,
    ).toMatchObject({ type: "oauth2" });
    // but a present clientId must be a non-empty string.
    expect(() =>
      validateConnectorManifest({
        ...base,
        auth: { type: "oauth2", authorizationEndpoint: "https://x/auth", tokenEndpoint: "https://x/token", clientId: "" } as any,
      })
    ).toThrow("clientId must be a non-empty string");
    // confidential (client_secret_*) implies BYO: clientId + a secret method is rejected.
    expect(() =>
      validateConnectorManifest({
        ...base,
        auth: {
          type: "oauth2",
          authorizationEndpoint: "https://x/auth",
          tokenEndpoint: "https://x/token",
          clientId: "cid",
          tokenEndpointAuthMethod: "client_secret_post",
        },
      })
    ).toThrow("requires a BYO client");
    // BYO + confidential (no clientId) is valid.
    expect(
      validateConnectorManifest({
        ...base,
        auth: {
          type: "oauth2",
          authorizationEndpoint: "https://x/auth",
          tokenEndpoint: "https://x/token",
          tokenEndpointAuthMethod: "client_secret_post",
        },
      }).auth,
    ).toMatchObject({ tokenEndpointAuthMethod: "client_secret_post" });
    expect(() =>
      validateConnectorManifest({
        ...base,
        auth: {
          type: "oauth2",
          authorizationEndpoint: "https://x/auth",
          tokenEndpoint: "https://x/token",
          clientId: "cid",
          scope: "read" as any,
        },
      })
    ).toThrow("scope must be an array of strings");
    expect(() =>
      validateConnectorManifest({
        ...base,
        auth: {
          type: "oauth2",
          authorizationEndpoint: "https://x/auth",
          tokenEndpoint: "https://x/token",
          clientId: "cid",
          tokenEndpointAuthMethod: "client_secret_jwt" as any,
        },
      })
    ).toThrow("tokenEndpointAuthMethod is invalid");
    expect(() =>
      validateConnectorManifest({ ...base, auth: { type: "localPermission" } as any })
    ).toThrow("invalid auth type");

    // Config schema: a valid map of fields is accepted and normalized.
    expect(
      validateConnectorManifest({
        ...base,
        config: { interval: { type: "number", label: "Interval (ms)", default: 5000 } },
      }).config,
    ).toEqual({ interval: { type: "number", label: "Interval (ms)", default: 5000 } });
    expect(() =>
      validateConnectorManifest({ ...base, config: [] as any })
    ).toThrow("must be a map of fields");
    expect(() =>
      validateConnectorManifest({ ...base, config: { x: { type: "json" as any, label: "X" } } })
    ).toThrow("invalid type");
    expect(() =>
      validateConnectorManifest({ ...base, config: { x: { type: "number" } as any } })
    ).toThrow("requires a label");
    expect(() =>
      validateConnectorManifest({
        ...base,
        config: { x: { type: "number", label: "X", default: "five" as any } },
      })
    ).toThrow("default must be a number");
  });

  test("runs a connector with bound guard, config, and persistent state", async () => {
    const definition: ConnectorDefinition<{ label: string; extra?: boolean }, { cursor: string }> = {
      async run({ guard, state, config, host }) {
        expect(await state.get()).toBeUndefined();
        expect(config).toEqual({ label: "override", extra: true });
        expect(host.workspacePath).toBe(workspace);
        await guard.writeEvent({
          type: "app.commit",
          externalId: "abc123",
          startedAt: 1000,
          payload: { sha: "abc123", label: config.label },
        });
        await state.set({ cursor: "abc123" });
      },
    };

    supervisor.register(
      {
        id: "app-commits",
        name: "App Commits",
        entry: "./index.ts",
        runtime: { mode: "poll" },
        integrations: { mode: "singleton" },
        auth: { type: "none" },
      },
      definition,
    );
    const integration = supervisor.ensureIntegration({
      connectorId: "app-commits",
      config: { label: "integration", extra: true },
    });

    expect(integration.id).not.toBe("app-commits");
    await supervisor.run(integration.id, { config: { label: "override" } });

    const event = dataDb.prepare("SELECT * FROM events WHERE type = ?").get("app.commit") as any;
    expect(event.source).toBe("connector:app-commits");
    expect(event.external_id).toBe("abc123");
    expect(JSON.parse(event.payload)).toEqual({ sha: "abc123", label: "override" });

    const stored = supervisor.getIntegration<unknown, { cursor: string }>(integration.id);
    expect(stored?.status).toBe("idle");
    expect(stored?.syncState).toEqual({ cursor: "abc123" });
    expect(stored?.lastRunAt).toBeGreaterThan(0);

    expect(() => dataDb.prepare("SELECT * FROM connector_integrations").all()).toThrow("no such table");
    const storedState = systemDb
      .prepare("SELECT status, sync_state FROM connector_integrations WHERE id = ?")
      .get(integration.id) as { status: string; sync_state: string };
    expect(storedState.status).toBe("idle");
    expect(JSON.parse(storedState.sync_state)).toEqual({ cursor: "abc123" });
  });

  test("merges config-schema defaults under integration and run overrides", async () => {
    let received: unknown;
    const definition: ConnectorDefinition = {
      async run({ config }) {
        received = config;
      },
    };
    supervisor.register(
      {
        id: "cfg-merge",
        name: "Cfg Merge",
        entry: "./index.ts",
        runtime: { mode: "poll" },
        integrations: { mode: "singleton" },
        auth: { type: "none" },
        config: {
          interval: { type: "number", label: "Interval", default: 5000 },
          label: { type: "string", label: "Label", default: "base" },
          extra: { type: "boolean", label: "Extra", default: false },
        },
      },
      definition,
    );
    const integration = supervisor.ensureIntegration({
      connectorId: "cfg-merge",
      config: { label: "integration" },
    });
    await supervisor.run(integration.id, { config: { extra: true } });

    // interval = schema default, label = integration override, extra = run override
    expect(received).toEqual({ interval: 5000, label: "integration", extra: true });
  });

  test("supports multiple connector instances with separate sources and state", async () => {
    const definition: ConnectorDefinition<{ externalId: string }, { seen: string }> = {
      async run({ guard, state, config }) {
        await guard.writeEvent({
          type: "calendar.event",
          externalId: config.externalId,
          startedAt: 2000,
          payload: { id: config.externalId },
        });
        await state.set({ seen: config.externalId });
      },
    };

    supervisor.register(
      {
        id: "calendar",
        name: "Calendar",
        entry: "./index.ts",
        runtime: { mode: "poll" },
        integrations: { mode: "multiple" },
        auth: { type: "none" },
      },
      definition,
    );
    const personal = supervisor.ensureIntegration({ connectorId: "calendar", integrationKey: "personal", config: { externalId: "same" } });
    const work = supervisor.ensureIntegration({ connectorId: "calendar", integrationKey: "work", config: { externalId: "same" } });

    expect(personal.id).not.toBe("calendar:personal");
    expect(work.id).not.toBe("calendar:work");
    await supervisor.run(personal.id);
    await supervisor.run(work.id);

    const rows = dataDb.prepare("SELECT source, external_id FROM events ORDER BY source").all() as any[];
    expect(rows).toEqual([
      { source: "connector:calendar:personal", external_id: "same" },
      { source: "connector:calendar:work", external_id: "same" },
    ]);
    expect(supervisor.getIntegration(personal.id)?.syncState).toEqual({ seen: "same" });
    expect(supervisor.getIntegration(work.id)?.syncState).toEqual({ seen: "same" });
  });

  test("edits a multi-integration setup row into a keyed integration", async () => {
    const definition: ConnectorDefinition<{ externalId: string }, { seen: string }> = {
      async run({ guard, state, config }) {
        await guard.writeEvent({
          type: "calendar.event",
          externalId: config.externalId,
          startedAt: 2100,
          payload: { id: config.externalId },
        });
        await state.set({ seen: config.externalId });
      },
    };

    supervisor.register(
      {
        id: "calendar",
        name: "Calendar",
        entry: "./index.ts",
        runtime: { mode: "poll" },
        integrations: { mode: "multiple" },
        auth: { type: "none" },
      },
      definition,
    );

    const setup = supervisor.ensureFirstIntegration("calendar");
    expect(setup.integrationKey).toBeUndefined();
    expect(setup.setupStatus).toBe("setup");
    expect((await supervisor.list())[0].source).toBeUndefined();
    expect(() =>
      supervisor.ensureIntegration({ connectorId: "calendar", setupStatus: "ready" })
    ).toThrow("requires an integration_key");
    expect(() =>
      supervisor.updateIntegration(setup.id, { setupStatus: "ready" })
    ).toThrow("requires an integration_key");

    const ready = supervisor.updateIntegration<{ externalId: string }, { seen: string }>(setup.id, {
      integrationKey: "work",
      setupStatus: "ready",
      config: { externalId: "event-1" },
    });
    expect(ready.id).toBe(setup.id);
    expect(ready.integrationKey).toBe("work");
    expect(ready.setupStatus).toBe("ready");
    expect((await supervisor.list())[0].source).toBe("connector:calendar:work");

    await supervisor.run(ready.id);

    const event = dataDb.prepare("SELECT source, external_id FROM events").get() as any;
    expect(event).toEqual({ source: "connector:calendar:work", external_id: "event-1" });
    expect(supervisor.getIntegration(ready.id)?.syncState).toEqual({ seen: "event-1" });
    expect(() =>
      supervisor.updateIntegration(ready.id, { integrationKey: "personal" })
    ).toThrow("rename requires an explicit migration");
  });

  test("provides auth as a capability handle", async () => {
    let tokenSeen = "";
    const definition: ConnectorDefinition = {
      async run({ auth, guard }) {
        if (auth.type === "none") throw new Error("expected auth");
        tokenSeen = await auth.getToken();
        await guard.writeEvent({
          type: "oura.sample",
          externalId: "sample-1",
          startedAt: 3000,
          payload: { ok: true },
        });
      },
    };

    supervisor.register(
      {
        id: "oura",
        name: "Oura",
        entry: "./index.ts",
        runtime: { mode: "poll" },
        integrations: { mode: "singleton" },
        auth: { type: "apiKey", label: "Oura Token" },
      },
      definition,
    );
    const integration = supervisor.ensureIntegration({ connectorId: "oura" });
    expect(integration.setupStatus).toBe("setup");
    await expect(supervisor.connectIntegration(integration.id)).rejects.toThrow("requires credentials");
    expect(() =>
      supervisor.updateIntegration(integration.id, { setupStatus: "ready" })
    ).toThrow("requires credentials");
    await supervisor.getAuthManager().setToken(integration.authRef!, "secret-token");
    const ready = await supervisor.connectIntegration(integration.id);
    expect(
      supervisor.updateIntegration(ready.id, { config: { sample: true } }).setupStatus
    ).toBe("ready");
    expect(() =>
      supervisor.updateIntegration(ready.id, { authRef: "missing-token-ref" })
    ).toThrow("authRef changes must use connectIntegration");

    await supervisor.getAuthManager().setToken("rotated-ref", "rotated-token");
    const rotated = await supervisor.connectIntegration(ready.id, { authRef: "rotated-ref" });
    expect(rotated.setupStatus).toBe("ready");
    expect(rotated.authRef).toBe("rotated-ref");

    await supervisor.run(rotated.id);

    expect(tokenSeen).toBe("rotated-token");
    const event = dataDb.prepare("SELECT source, type FROM events").get() as any;
    expect(event).toEqual({ source: "connector:oura", type: "oura.sample" });
  });

  test("connector guard accepts non-object JSON payloads and rejects non-JSON payloads", async () => {
    supervisor.register(
      {
        id: "json-feed",
        name: "JSON Feed",
        entry: "./index.ts",
        runtime: { mode: "manual" },
        integrations: { mode: "singleton" },
        auth: { type: "none" },
      },
      {
        async run({ guard }) {
          await guard.writeEvent({
            type: "json.string",
            externalId: "json-string",
            startedAt: 3100,
            payload: "hello",
          });
          await expect(guard.writeEvent({
            type: "json.bad",
            externalId: "json-bad",
            startedAt: 3101,
            payload: (() => undefined) as any,
          })).rejects.toThrow("JSON-serializable");
        },
      },
    );
    const integration = supervisor.ensureIntegration({ connectorId: "json-feed" });

    await supervisor.run(integration.id);

    const event = dataDb.prepare("SELECT payload FROM events WHERE type = ?").get("json.string") as any;
    expect(JSON.parse(event.payload)).toBe("hello");
  });

  test("connector guard requires externalId", async () => {
    supervisor.register(
      {
        id: "id-feed",
        name: "ID Feed",
        entry: "./index.ts",
        runtime: { mode: "manual" },
        integrations: { mode: "singleton" },
        auth: { type: "none" },
      },
      {
        async run({ guard }) {
          await expect(guard.writeEvent({
            type: "id-feed.event",
            startedAt: 3110,
            payload: { ok: true },
          } as any)).rejects.toThrow("externalId");
        },
      },
    );
    const integration = supervisor.ensureIntegration({ connectorId: "id-feed" });

    await supervisor.run(integration.id);
  });

  test("connector guard treats duplicate externalId writes as idempotent", async () => {
    const ids: string[] = [];
    supervisor.register(
      {
        id: "retry-feed",
        name: "Retry Feed",
        entry: "./index.ts",
        runtime: { mode: "poll" },
        integrations: { mode: "singleton" },
        auth: { type: "none" },
      },
      {
        async run({ guard }) {
          const first = await guard.writeEvent({
            type: "retry.sample",
            externalId: "same-event",
            startedAt: 3500,
            payload: { attempt: 1 },
          });
          const second = await guard.writeEvent({
            type: "retry.sample",
            externalId: "same-event",
            startedAt: 3500,
            payload: { attempt: 2 },
          });
          ids.push(first.id, second.id);
        },
      },
    );

    const integration = supervisor.ensureIntegration({ connectorId: "retry-feed" });
    await supervisor.run(integration.id);

    expect(ids[0]).toBe(ids[1]);
    const rows = dataDb.prepare("SELECT source, external_id, payload FROM events").all() as any[];
    expect(rows).toHaveLength(1);
    expect(rows[0].source).toBe("connector:retry-feed");
    expect(rows[0].external_id).toBe("same-event");
    expect(JSON.parse(rows[0].payload)).toEqual({ attempt: 1 });
  });

  test("blocks runs up front when credentials disappear after ready", async () => {
    let connectorSawAuth = false;
    supervisor.register(
      {
        id: "revoked-feed",
        name: "Revoked Feed",
        entry: "./index.ts",
        runtime: { mode: "poll" },
        integrations: { mode: "singleton" },
        auth: { type: "apiKey" },
      },
      {
        async run({ auth }) {
          connectorSawAuth = true;
          if (auth.type === "none") throw new Error("expected auth");
          await auth.getToken();
        },
      },
    );

    const integration = supervisor.ensureIntegration({ connectorId: "revoked-feed" });
    await supervisor.getAuthManager().setToken(integration.authRef!, "token");
    const ready = await supervisor.connectIntegration(integration.id);
    expect(ready.setupStatus).toBe("ready");

    // Token revoked after ready: the run must fail before connector code
    // executes, and the integration drops back to setup.
    await supervisor.getAuthManager().deleteToken(integration.authRef!);
    await expect(supervisor.run(integration.id)).rejects.toThrow("credentials are missing");
    expect(connectorSawAuth).toBe(false);
    expect(supervisor.getIntegration(integration.id)?.setupStatus).toBe("setup");
    expect(supervisor.getIntegration(integration.id)?.status).toBe("error");
  });

  test("watch scheduler restarts integrations after setup recovery", async () => {
    supervisor.register(
      {
        id: "auth-watch",
        name: "Auth Watch",
        entry: "./index.ts",
        runtime: { mode: "watch" },
        integrations: { mode: "singleton" },
        auth: { type: "apiKey" },
      },
      {
        async run({ signal }) {
          await new Promise<void>((resolve) => {
            if (signal.aborted) {
              resolve();
            } else {
              signal.addEventListener("abort", () => resolve(), { once: true });
            }
          });
        },
      },
    );

    const integration = supervisor.ensureIntegration({ connectorId: "auth-watch" });
    await supervisor.getAuthManager().setToken(integration.authRef!, "token");
    await supervisor.connectIntegration(integration.id);

    // Credentials revoked: the run-gate failure leaves a setup-blocked error.
    await supervisor.getAuthManager().deleteToken(integration.authRef!);
    await expect(supervisor.run(integration.id)).rejects.toThrow("credentials are missing");
    expect(supervisor.getIntegration(integration.id)?.status).toBe("error");
    expect(supervisor.getIntegration(integration.id)?.setupStatus).toBe("setup");

    // Reconnect promotes back to ready and resets the setup-blocked error to
    // idle, so the watch scheduler picks the integration up again.
    await supervisor.getAuthManager().setToken(integration.authRef!, "token-2");
    const recovered = await supervisor.connectIntegration(integration.id);
    expect(recovered.setupStatus).toBe("ready");
    expect(recovered.status).toBe("idle");
    expect(recovered.lastError).toBeUndefined();

    const scheduler = new ConnectorScheduler({ supervisor });
    await scheduler.tick();
    expect((await supervisor.list())[0].running).toBe(true);
    await scheduler.stop();
    expect((await supervisor.list())[0].running).toBe(false);
  });

  test("crashed watch runs need explicit restart before the scheduler picks them up", async () => {
    let crash = true;
    supervisor.register(
      {
        id: "crashy-watch",
        name: "Crashy Watch",
        entry: "./index.ts",
        runtime: { mode: "watch" },
        integrations: { mode: "singleton" },
        auth: { type: "none" },
      },
      {
        async run({ signal }) {
          if (crash) throw new Error("connector bug");
          await new Promise<void>((resolve) => {
            if (signal.aborted) {
              resolve();
            } else {
              signal.addEventListener("abort", () => resolve(), { once: true });
            }
          });
        },
      },
    );
    const integration = supervisor.ensureIntegration({ connectorId: "crashy-watch" });
    const scheduler = new ConnectorScheduler({ supervisor, onError() {} });

    // Crash leaves a needs-attention error that further ticks do not retry.
    await scheduler.tick();
    await Promise.resolve();
    while ((await supervisor.list())[0].running) {
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    expect(supervisor.getIntegration(integration.id)?.status).toBe("error");
    expect(supervisor.getIntegration(integration.id)?.lastError).toContain("connector bug");

    crash = false;
    await scheduler.tick();
    expect((await supervisor.list())[0].running).toBe(false);
    expect(supervisor.getIntegration(integration.id)?.status).toBe("error");

    // Explicit restart resets to idle and the scheduler picks it up again.
    const restarted = supervisor.restartIntegration(integration.id);
    expect(restarted.status).toBe("idle");
    expect(restarted.lastError).toBeUndefined();

    await scheduler.tick();
    expect((await supervisor.list())[0].running).toBe(true);
    expect(() => supervisor.restartIntegration(integration.id)).toThrow("already running");
    await scheduler.stop();
  });

  test("restart guards disabled and setup integrations", async () => {
    supervisor.register(
      {
        id: "guarded-feed",
        name: "Guarded Feed",
        entry: "./index.ts",
        runtime: { mode: "poll" },
        integrations: { mode: "singleton" },
        auth: { type: "apiKey" },
      },
      { async run() {} },
    );
    const integration = supervisor.ensureIntegration({ connectorId: "guarded-feed" });
    expect(integration.setupStatus).toBe("setup");
    expect(() => supervisor.restartIntegration(integration.id)).toThrow("not set up");
    expect(() => supervisor.restartIntegration("missing-id")).toThrow("not found");
  });

  test("fails auth connectors without credentials and records integration error", async () => {
    supervisor.register(
      {
        id: "oura",
        name: "Oura",
        entry: "./index.ts",
        runtime: { mode: "poll" },
        integrations: { mode: "singleton" },
        auth: { type: "apiKey" },
      },
      {
        async run({ auth }) {
          if (auth.type === "none") throw new Error("expected auth");
          await auth.getToken();
        },
      },
    );
    const integration = supervisor.ensureIntegration({ connectorId: "oura" });

    expect(integration.setupStatus).toBe("setup");
    await expect(supervisor.run(integration.id)).rejects.toThrow("not set up");
    const stored = supervisor.getIntegration(integration.id);
    expect(stored?.status).toBe("setup");
    expect(stored?.lastError).toBeUndefined();
  });

  test("gates integrations by platform", () => {
    const linuxSupervisor = new ConnectorSupervisor({
      systemDb,
      guard: new Guard({ db: dataDb, source: "system:test" }),
      host: { workspacePath: workspace },
      platform: "linux",
    });
    linuxSupervisor.register(
      {
        id: "macos-ax",
        name: "macOS Accessibility",
        entry: "./index.ts",
        runtime: { mode: "watch" },
        integrations: { mode: "multiple" },
        platforms: {
          darwin: {
            requirements: ["macos-accessibility"],
          },
        },
        auth: { type: "none" },
      },
      { async run() {} },
    );

    expect(() =>
      linuxSupervisor.ensureIntegration({ connectorId: "macos-ax" })
    ).toThrow("not supported on linux");

    // First-integration bookkeeping still creates a visible non-runnable row.
    const row = linuxSupervisor.ensureFirstIntegration("macos-ax");
    expect(row.setupStatus).toBe("setup");
  });

  test("gates no-auth integrations behind platform requirement lifecycle", async () => {
    let granted = false;
    supervisor.register(
      {
        id: "ax-watch",
        name: "AX Watch",
        entry: "./index.ts",
        runtime: { mode: "poll" },
        integrations: { mode: "singleton" },
        platforms: {
          darwin: { requirements: ["macos-accessibility"] },
        },
        auth: { type: "none" },
      },
      {
        async run({ guard }) {
          await guard.writeEvent({
            type: "ax.sample",
            externalId: "ax-1",
            startedAt: 6000,
            payload: { ok: true },
          });
        },
        requirements: {
          "macos-accessibility": {
            label: "Accessibility",
            async check() {
              return granted
                ? { status: "satisfied" }
                : { status: "missing", message: "Accessibility access is not granted." };
            },
            async request() {
              granted = true;
              return { status: "pending", message: "Granting..." };
            },
          },
        },
      },
    );

    // First integration must not be ready while requirements are unchecked.
    const integration = supervisor.ensureFirstIntegration("ax-watch");
    expect(integration.setupStatus).toBe("setup");
    await expect(supervisor.run(integration.id)).rejects.toThrow("not set up");

    // setupStatus cannot bypass the requirement gate.
    expect(() =>
      supervisor.updateIntegration(integration.id, { setupStatus: "ready" })
    ).toThrow("requires platform requirements");

    // check() persists status and keeps the integration in setup.
    const missing = await supervisor.checkIntegrationRequirements(integration.id);
    expect(missing["macos-accessibility"].status).toBe("missing");
    expect(missing["macos-accessibility"].message).toContain("not granted");
    const listed = (await supervisor.list())[0];
    expect(listed.requirements).toEqual([
      expect.objectContaining({ id: "macos-accessibility", status: "missing" }),
    ]);
    expect(supervisor.getIntegration(integration.id)?.setupStatus).toBe("setup");

    // request() resolves the requirement and the evaluator promotes to ready.
    const requested = await supervisor.requestIntegrationRequirement(
      integration.id,
      "macos-accessibility",
    );
    expect(requested.status).toBe("satisfied");
    expect(supervisor.getIntegration(integration.id)?.setupStatus).toBe("ready");

    await supervisor.run(integration.id);
    const event = dataDb.prepare("SELECT source, type FROM events").get() as any;
    expect(event).toEqual({ source: "connector:ax-watch", type: "ax.sample" });

    // Requirement regression blocks the next run and demotes back to setup.
    granted = false;
    await expect(supervisor.run(integration.id)).rejects.toThrow("requirements not satisfied");
    expect(supervisor.getIntegration(integration.id)?.setupStatus).toBe("setup");
    expect(supervisor.getIntegration(integration.id)?.status).toBe("error");
  });

  test("allows connecting auth before requirements are granted", async () => {
    let granted = false;
    supervisor.register(
      {
        id: "auth-ax",
        name: "Auth AX",
        entry: "./index.ts",
        runtime: { mode: "poll" },
        integrations: { mode: "singleton" },
        platforms: {
          darwin: { requirements: ["macos-accessibility"] },
        },
        auth: { type: "apiKey" },
      },
      {
        async run() {},
        requirements: {
          "macos-accessibility": {
            label: "Accessibility",
            async check() {
              return granted
                ? { status: "satisfied" }
                : { status: "missing", message: "Not granted." };
            },
            async request() {
              return { status: "pending", message: "Grant access in System Settings." };
            },
          },
        },
      },
    );

    const integration = supervisor.ensureFirstIntegration("auth-ax");
    expect(integration.setupStatus).toBe("setup");

    // Auth connects first: credentials bind, but the integration stays in
    // setup because the platform requirement is still missing.
    await supervisor.getAuthManager().setToken(integration.authRef!, "token");
    const connected = await supervisor.connectIntegration(integration.id);
    expect(connected.setupStatus).toBe("setup");
    expect(connected.authRef).toBe(integration.authRef);

    // request() reports pending and the immediate re-check still says missing:
    // the pending record must stay visible for the UI.
    const pending = await supervisor.requestIntegrationRequirement(
      integration.id,
      "macos-accessibility",
    );
    expect(pending.status).toBe("pending");
    expect(pending.message).toContain("System Settings");
    expect((await supervisor.list())[0].requirements).toEqual([
      expect.objectContaining({ id: "macos-accessibility", status: "pending" }),
    ]);

    // Once the requirement is granted, a check promotes to ready without
    // reconnecting auth.
    granted = true;
    const records = await supervisor.checkIntegrationRequirements(integration.id);
    expect(records["macos-accessibility"].status).toBe("satisfied");
    expect(supervisor.getIntegration(integration.id)?.setupStatus).toBe("ready");

    await supervisor.run(integration.id);
  });

  test("records an error when a declared requirement has no handler", async () => {
    supervisor.register(
      {
        id: "no-handler",
        name: "No Handler",
        entry: "./index.ts",
        runtime: { mode: "poll" },
        integrations: { mode: "singleton" },
        platforms: {
          darwin: { requirements: ["macos-accessibility"] },
        },
        auth: { type: "none" },
      },
      { async run() {} },
    );

    const integration = supervisor.ensureFirstIntegration("no-handler");
    expect(integration.setupStatus).toBe("setup");

    const records = await supervisor.checkIntegrationRequirements(integration.id);
    expect(records["macos-accessibility"].status).toBe("error");
    expect(records["macos-accessibility"].message).toContain("does not implement requirement handler");
    await expect(
      supervisor.requestIntegrationRequirement(integration.id, "macos-accessibility")
    ).rejects.toThrow("does not implement requirement handler");
    await expect(supervisor.run(integration.id)).rejects.toThrow("not set up");
  });

  test("requirement checks pass the trust gate before importing connector code", async () => {
    const sourceDir = join(workspace, "connectors", "untrusted-ax");
    mkdirSync(sourceDir, { recursive: true });
    writeFileSync(
      join(sourceDir, "connector.yaml"),
      `id: untrusted-ax
name: Untrusted AX
entry: ./index.mjs
runtime:
  mode: poll
integrations:
  mode: singleton
platforms:
  darwin:
    requirements:
      - macos-accessibility
auth:
  type: none
`,
    );
    writeFileSync(
      join(sourceDir, "index.mjs"),
      `export default {
  async run() {},
  requirements: {
    "macos-accessibility": {
      label: "Accessibility",
      async check() {
        return { status: "satisfied" };
      },
    },
  },
};
`,
    );

    await registerWorkspaceConnectors(supervisor, workspace);
    const integration = (await supervisor.list())[0];
    expect(integration.packageTrust).toBe("untrusted");
    expect(integration.requirements).toEqual([
      expect.objectContaining({ id: "macos-accessibility", status: "unknown" }),
    ]);

    await expect(supervisor.checkIntegrationRequirements(integration.id)).rejects.toThrow("not trusted");

    await supervisor.approveCurrentPackage("untrusted-ax");
    const records = await supervisor.checkIntegrationRequirements(integration.id);
    expect(records["macos-accessibility"].status).toBe("satisfied");
    expect(supervisor.getIntegration(integration.id)?.setupStatus).toBe("ready");
  });

  test("starts and aborts watch connector runs", async () => {
    supervisor.register(
      {
        id: "terminal",
        name: "Terminal",
        entry: "./index.ts",
        runtime: { mode: "watch" },
        integrations: { mode: "singleton" },
        auth: { type: "none" },
      },
      {
        async run({ signal, state, guard }) {
          await guard.writeEvent({
            type: "terminal.session.started",
            externalId: "s1",
            startedAt: 4000,
            payload: { session: "s1" },
          });
          await new Promise<void>((resolve) => {
            if (signal.aborted) {
              resolve();
            } else {
              signal.addEventListener("abort", () => resolve(), { once: true });
            }
          });
          await state.set({ stopped: true });
        },
      },
    );
    const integration = supervisor.ensureIntegration({ connectorId: "terminal" });

    const handle = supervisor.start(integration.id);
    expect((await supervisor.list())[0].running).toBe(true);
    handle.abort();
    await handle.promise;

    expect((await supervisor.list())[0].running).toBe(false);
    expect(supervisor.getIntegration(integration.id)?.status).toBe("idle");
    expect(supervisor.getIntegration(integration.id)?.syncState).toEqual({ stopped: true });
  });

  test("scheduler starts watch connectors and stops them on shutdown", async () => {
    supervisor.register(
      {
        id: "watch-feed",
        name: "Watch Feed",
        entry: "./index.ts",
        runtime: { mode: "watch" },
        integrations: { mode: "singleton" },
        auth: { type: "none" },
      },
      {
        async run({ signal, state }) {
          await new Promise<void>((resolve) => {
            if (signal.aborted) {
              resolve();
            } else {
              signal.addEventListener("abort", () => resolve(), { once: true });
            }
          });
          await state.set({ stopped: true });
        },
      },
    );
    const integration = supervisor.ensureIntegration({ connectorId: "watch-feed" });
    const scheduler = new ConnectorScheduler({ supervisor, tickMs: 60_000 });

    await scheduler.start();
    expect((await supervisor.list())[0].running).toBe(true);

    await scheduler.stop();
    expect((await supervisor.list())[0].running).toBe(false);
    expect(supervisor.getIntegration(integration.id)?.status).toBe("idle");
    expect(supervisor.getIntegration(integration.id)?.syncState).toEqual({ stopped: true });
  });

  test("scheduler stop aborts in-flight poll runs", async () => {
    supervisor.register(
      {
        id: "slow-poll",
        name: "Slow Poll",
        entry: "./index.ts",
        runtime: { mode: "poll", defaultSchedule: "*/15 * * * *" },
        integrations: { mode: "singleton" },
        auth: { type: "none" },
      },
      {
        async run({ signal, state }) {
          await new Promise<void>((resolve) => {
            if (signal.aborted) {
              resolve();
            } else {
              signal.addEventListener("abort", () => resolve(), { once: true });
            }
          });
          await state.set({ aborted: true });
        },
      },
    );
    const integration = supervisor.ensureIntegration({ connectorId: "slow-poll" });
    const scheduler = new ConnectorScheduler({ supervisor });

    const tick = scheduler.tick();
    while (!(await supervisor.list())[0].running) {
      await new Promise((resolve) => setTimeout(resolve, 1));
    }

    await scheduler.stop();
    await tick;

    expect((await supervisor.list())[0].running).toBe(false);
    expect(supervisor.getIntegration(integration.id)?.status).toBe("idle");
    expect(supervisor.getIntegration(integration.id)?.syncState).toEqual({ aborted: true });
    expect(supervisor.getIntegration(integration.id)?.nextRunAt).toBeGreaterThan(0);
  });

  test("scheduler stop does not hang when a run ignores the abort signal", async () => {
    supervisor.register(
      {
        id: "stubborn-watch",
        name: "Stubborn Watch",
        entry: "./index.ts",
        runtime: { mode: "watch" },
        integrations: { mode: "singleton" },
        auth: { type: "none" },
      },
      {
        async run() {
          await new Promise(() => {});
        },
      },
    );
    supervisor.ensureIntegration({ connectorId: "stubborn-watch" });
    const scheduler = new ConnectorScheduler({ supervisor, stopTimeoutMs: 50 });

    await scheduler.start();
    expect((await supervisor.list())[0].running).toBe(true);

    const stopped = await waitWithTestTimeout(scheduler.stop(), 2_000);
    expect(stopped).toBe(true);
  });

  test("scheduler runs due poll connectors and stores the next run time", async () => {
    let now = new Date("2026-01-01T00:00:00Z").getTime();
    let runs = 0;
    supervisor.register(
      {
        id: "poll-feed",
        name: "Poll Feed",
        entry: "./index.ts",
        runtime: { mode: "poll", defaultSchedule: "*/15 * * * *" },
        integrations: { mode: "singleton" },
        auth: { type: "none" },
      },
      {
        async run({ guard }) {
          runs += 1;
          await guard.writeEvent({
            type: "poll.sample",
            externalId: `run-${runs}`,
            startedAt: now,
            payload: { runs },
          });
        },
      },
    );
    const integration = supervisor.ensureIntegration({ connectorId: "poll-feed" });
    expect(() =>
      supervisor.updateIntegration(integration.id, { scheduleCron: "every 1m" })
    ).toThrow("Unsupported connector schedule");
    const scheduler = new ConnectorScheduler({ supervisor, now: () => now });

    await scheduler.tick();
    expect(runs).toBe(1);
    const afterFirstRun = supervisor.getIntegration(integration.id);
    expect(afterFirstRun?.nextRunAt).toBe(nextCronRunAt("*/15 * * * *", now));

    await scheduler.tick();
    expect(runs).toBe(1);

    now = afterFirstRun!.nextRunAt!;
    await scheduler.tick();
    expect(runs).toBe(2);
    expect(supervisor.getIntegration(integration.id)?.nextRunAt).toBe(nextCronRunAt("*/15 * * * *", now));
  });

  test("scheduler validates poll schedules before running", async () => {
    let runs = 0;
    supervisor.register(
      {
        id: "invalid-schedule-feed",
        name: "Invalid Schedule Feed",
        entry: "./index.ts",
        runtime: { mode: "poll", defaultSchedule: "*/15 * * * *" },
        integrations: { mode: "singleton" },
        auth: { type: "none" },
      },
      {
        async run({ guard }) {
          runs += 1;
          await guard.writeEvent({
            type: "invalid-schedule.sample",
            externalId: `run-${runs}`,
            startedAt: 1,
            payload: { runs },
          });
        },
      },
    );
    const integration = supervisor.ensureIntegration({ connectorId: "invalid-schedule-feed" });
    systemDb.prepare("UPDATE connector_integrations SET schedule_cron = ?, next_run_at = NULL WHERE id = ?")
      .run("every 1m", integration.id);
    const errors: unknown[] = [];
    const scheduler = new ConnectorScheduler({
      supervisor,
      onError(err) {
        errors.push(err);
      },
    });

    await scheduler.tick();
    await scheduler.tick();

    expect(runs).toBe(0);
    expect(errors).toHaveLength(2);
    const event = dataDb.prepare("SELECT * FROM events WHERE type = ?").get("invalid-schedule.sample");
    expect(event).toBeFalsy();
  });

  test("scheduler does not run untrusted workspace connector packages", async () => {
    const sourceDir = join(workspace, "connectors", "untrusted-feed");
    mkdirSync(sourceDir, { recursive: true });
    writeFileSync(
      join(sourceDir, "connector.yaml"),
      `id: untrusted-feed
name: Untrusted Feed
entry: ./index.mjs
runtime:
  mode: poll
  defaultSchedule: "*/15 * * * *"
integrations:
  mode: singleton
platforms:
  darwin: {}
auth:
  type: none
`,
    );
    writeFileSync(
      join(sourceDir, "index.mjs"),
      `export default {
  async run({ guard }) {
    await guard.writeEvent({
      type: "untrusted.sample",
      externalId: "sample",
      startedAt: 1,
      payload: { ok: true },
    });
  },
};
`,
    );

    await registerWorkspaceConnectors(supervisor, workspace);
    expect((await supervisor.list())[0].packageTrust).toBe("untrusted");

    const scheduler = new ConnectorScheduler({ supervisor });
    await scheduler.tick();

    const event = dataDb.prepare("SELECT * FROM events WHERE type = ?").get("untrusted.sample");
    expect(event).toBeFalsy();
  });

  test("app-commits syncs app git repos with per-app cursors", async () => {
    const appCommitsUrl = new URL("../../template/connectors/app-commits/index.mjs", import.meta.url).href;
    const { syncOnce } = await import(appCommitsUrl) as {
      syncOnce(context: unknown): Promise<void>;
    };
    const appDir = join(workspace, "apps", "hello-world");
    mkdirSync(appDir, { recursive: true });
    execFileSync("git", ["-C", appDir, "init"], { stdio: "ignore" });
    execFileSync("git", ["-C", appDir, "config", "user.name", "Test User"], { stdio: "ignore" });
    execFileSync("git", ["-C", appDir, "config", "user.email", "test@example.com"], { stdio: "ignore" });

    writeFileSync(join(appDir, "index.tsx"), "export default function App() { return null; }\n");
    execFileSync("git", ["-C", appDir, "add", "."], { stdio: "ignore" });
    execFileSync("git", ["-C", appDir, "commit", "-m", "Initial app"], { stdio: "ignore" });
    const firstSha = execFileSync("git", ["-C", appDir, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();

    let syncState: unknown;
    const events: any[] = [];
    const context = {
      guard: {
        async writeEvent(event: any) {
          events.push(event);
          return { id: `event-${events.length}` };
        },
      },
      state: {
        async get() {
          return syncState;
        },
        async set(next: unknown) {
          syncState = next;
        },
      },
      host: { workspacePath: workspace },
      signal: new AbortController().signal,
    };

    await syncOnce(context);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "app.commit",
      externalId: `hello-world:${firstSha}`,
      payload: {
        appId: "hello-world",
        commitSha: firstSha,
        authorName: "Test User",
        authorEmail: "test@example.com",
        message: "Initial app",
      },
    });

    writeFileSync(join(appDir, "index.tsx"), "export default function App() { return 'updated'; }\n");
    execFileSync("git", ["-C", appDir, "add", "."], { stdio: "ignore" });
    execFileSync("git", ["-C", appDir, "commit", "-m", "Update app", "-m", "Refine the render path."], { stdio: "ignore" });
    const secondSha = execFileSync("git", ["-C", appDir, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();

    await syncOnce(context);
    expect(events).toHaveLength(2);
    expect(events[1].externalId).toBe(`hello-world:${secondSha}`);
    // Full multi-line message (subject + body) is captured, not just the subject.
    expect(events[1].payload.message).toBe("Update app\n\nRefine the render path.");
    expect(syncState).toEqual({
      apps: {
        "hello-world": { lastSha: secondSha },
      },
    });

    syncState = {
      apps: {
        "hello-world": { lastSha: "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef" },
      },
    };
    const fallbackStart = events.length;
    await syncOnce(context);
    expect(events).toHaveLength(fallbackStart + 2);
    expect(events[fallbackStart].payload.message).toBe("Initial app");
    expect(events[fallbackStart + 1].payload.message).toBe("Update app\n\nRefine the render path.");
    expect(syncState).toEqual({
      apps: {
        "hello-world": { lastSha: secondSha },
      },
    });
  });

  test("oura sync uses revision-aware external ids and per-stream cursors", async () => {
    const ouraUrl = new URL("../../template/connectors/oura/index.mjs", import.meta.url).href;
    const { syncOnce } = await import(ouraUrl) as {
      syncOnce(context: unknown, deps?: unknown): Promise<void>;
    };

    let syncState: unknown;
    let score = 90;
    const events: any[] = [];
    const requests: URL[] = [];
    const context = {
      auth: {
        type: "oauth2",
        async getToken() {
          return "oura-token";
        },
      },
      guard: {
        async writeEvents(batch: any[]) {
          const start = events.length;
          events.push(...batch);
          return { ids: batch.map((_, index) => `event-${start + index}`) };
        },
      },
      state: {
        async get() {
          return syncState;
        },
        async set(next: unknown) {
          syncState = next;
        },
      },
      config: {
        initialStartDate: "2026-01-01",
        lookbackDays: 1,
        streams: ["daily_sleep"],
      },
      signal: new AbortController().signal,
    };

    const fetchImpl = async (url: string, init: RequestInit) => {
      const requestUrl = new URL(url);
      requests.push(requestUrl);
      expect((init.headers as Record<string, string>).Authorization).toBe("Bearer oura-token");
      return new Response(JSON.stringify({
        data: [{
          id: "sleep-doc-1",
          day: "2026-01-02",
          timestamp: "2026-01-02T08:00:00+00:00",
          contributors: { total_sleep: score },
          score,
        }],
        next_token: null,
      }), { status: 200 });
    };

    const now = Date.UTC(2026, 0, 3, 12);
    await syncOnce(context, { fetchImpl, now });
    const firstExternalId = events[0].externalId;

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "oura.daily_sleep",
      externalId: expect.stringMatching(/^daily_sleep:sleep-doc-1:[a-f0-9]{16}$/),
      startedAt: Date.UTC(2026, 0, 2),
      payload: {
        provider: "oura",
        stream: "daily_sleep",
        record: {
          id: "sleep-doc-1",
          day: "2026-01-02",
          score: 90,
        },
      },
    });
    expect(syncState).toEqual({
      version: 1,
      streams: {
        daily_sleep: {
          lastSyncedDate: "2026-01-03",
          lastSyncedAt: now,
        },
      },
    });
    expect(requests[0].searchParams.get("start_date")).toBe("2026-01-01");
    expect(requests[0].searchParams.get("end_date")).toBe("2026-01-03");

    score = 91;
    await syncOnce(context, { fetchImpl, now });

    expect(events).toHaveLength(2);
    expect(events[1].externalId).not.toBe(firstExternalId);
    expect(events[1].externalId).toMatch(/^daily_sleep:sleep-doc-1:[a-f0-9]{16}$/);
    expect(requests[1].searchParams.get("start_date")).toBe("2026-01-02");
    expect(requests[1].searchParams.get("end_date")).toBe("2026-01-03");
  });

  test("installs connectors as workspace folders, registers them, and removes the folder", async () => {
    const sourceDir = join(workspace, "source-connectors", "calendar");
    mkdirSync(sourceDir, { recursive: true });
    writeFileSync(
      join(sourceDir, "connector.yaml"),
      `id: calendar
name: Calendar
entry: ./index.mjs
runtime:
  mode: manual
integrations:
  mode: singleton
platforms:
  darwin: {}
auth:
  type: none
`,
    );
    writeFileSync(
      join(sourceDir, "index.mjs"),
      `export default {
  async run({ guard, state }) {
    await guard.writeEvent({
      type: "calendar.install-test",
      externalId: "installed",
      startedAt: 4500,
      payload: { installed: true },
    });
    await state.set({ installed: true });
  },
};
`,
    );

    const installed = await installConnector({ sourceDir, workspacePath: workspace });
    expect(installed.dir).toBe(join(workspace, "connectors", "calendar"));
    expect(readFileSync(join(installed.dir, "connector.yaml"), "utf8")).toContain("id: calendar");
    expect(await listInstalledConnectorDirs(workspace)).toEqual([installed.dir]);

    const manifests = await registerWorkspaceConnectors(supervisor, workspace);
    expect(manifests.map((manifest) => manifest.id)).toEqual(["calendar"]);
    const integration = (await supervisor.list())[0];
    expect(integration.id).not.toBe("calendar");

    await expect(supervisor.run(integration.id)).rejects.toThrow("not trusted");
    await supervisor.approveCurrentPackage("calendar");
    await supervisor.run(integration.id);

    const event = dataDb.prepare("SELECT source, type, external_id FROM events WHERE type = ?")
      .get("calendar.install-test") as any;
    expect(event).toEqual({
      source: "connector:calendar",
      type: "calendar.install-test",
      external_id: "installed",
    });
    expect(supervisor.getIntegration(integration.id)?.syncState).toEqual({ installed: true });
    expect(supervisor.getIntegration(integration.id)?.trustStatus).toBe("custom");

    expect(await removeInstalledConnector(workspace, "calendar")).toBe(true);
    expect(existsSync(installed.dir)).toBe(false);
    expect(await listInstalledConnectorDirs(workspace)).toEqual([]);
  });

  test("materializes built-in connectors through the same workspace connectors path", async () => {
    const sourceDir = join(workspace, "built-in-connectors", "app-commits");
    mkdirSync(sourceDir, { recursive: true });
    writeFileSync(
      join(sourceDir, "connector.json"),
      JSON.stringify({
        id: "app-commits",
        name: "App Commits",
        entry: "./index.mjs",
        runtime: { mode: "watch" },
        integrations: { mode: "singleton" },
        platforms: { darwin: {} },
        auth: { type: "none" },
      }),
    );
    writeFileSync(
      join(sourceDir, "index.mjs"),
      "export default { async run() {} };\n",
    );

    const installed = await materializeBuiltInConnector({ sourceDir, workspacePath: workspace });
    expect(installed.dir).toBe(join(workspace, "connectors", "app-commits"));
    expect((await loadConnectorManifest(installed.dir)).id).toBe("app-commits");
    await expect(materializeBuiltInConnector({ sourceDir, workspacePath: workspace }))
      .rejects.toThrow("Connector already installed: app-commits");
  });

  function writeBuiltIn(builtinsDir: string, id: string): string {
    const dir = join(builtinsDir, id);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "connector.yaml"),
      `id: ${id}
name: ${id}
entry: ./index.mjs
runtime:
  mode: manual
integrations:
  mode: singleton
platforms:
  darwin: {}
auth:
  type: none
`,
    );
    writeFileSync(join(dir, "index.mjs"), "export default { async run() {} };\n");
    return dir;
  }

  test("an omitted platforms map means supported everywhere", () => {
    const manifest = validateConnectorManifest({
      id: "anywhere",
      name: "Anywhere",
      entry: "./index.mjs",
      runtime: { mode: "manual" },
      integrations: { mode: "singleton" },
      auth: { type: "none" },
    } as ConnectorManifest);
    expect(isPlatformSupported(manifest, "darwin")).toBe(true);
    expect(isPlatformSupported(manifest, "linux")).toBe(true);

    const darwinOnly = validateConnectorManifest({
      ...manifest,
      platforms: { darwin: {} },
    });
    expect(isPlatformSupported(darwinOnly, "darwin")).toBe(true);
    expect(isPlatformSupported(darwinOnly, "linux")).toBe(false);
  });

  test("lists bundled built-ins as available and installs one explicitly", async () => {
    const guard = new Guard({ db: dataDb, source: "system:test" });
    const builtins = join(workspace, "builtins");
    writeBuiltIn(builtins, "seed");
    const broken = join(builtins, "broken");
    mkdirSync(broken, { recursive: true });
    writeFileSync(join(broken, "connector.yaml"), "id: broken\n");

    // Listing is read-only: valid entries surface, invalid ones are reported.
    const errors: string[] = [];
    const available = await listAvailableBuiltIns(builtins, (dir) => errors.push(dir));
    expect(available.map((entry) => entry.manifest.id)).toEqual(["seed"]);
    expect(errors).toEqual([broken]);
    expect(existsSync(join(workspace, "connectors", "seed"))).toBe(false);
    // Missing builtins dir (packaged without templates) is a quiet no-op.
    expect(await listAvailableBuiltIns(join(workspace, "no-such-dir"))).toEqual([]);

    // Explicit install: copies the package and records connector.installed.
    const installed = await installConnectorFromSource({
      sourceDir: join(builtins, "seed"),
      workspacePath: workspace,
      connectorId: "seed",
      guard,
    });
    expect(installed.dir).toBe(join(workspace, "connectors", "seed"));
    expect(existsSync(join(installed.dir, "index.mjs"))).toBe(true);

    const event = dataDb
      .prepare("SELECT payload FROM events WHERE type = ?")
      .get("connector.installed") as any;
    const payload = JSON.parse(event.payload);
    expect(payload.connector_id).toBe("seed");
    expect(typeof payload.package_hash).toBe("string");

    // Double-install is rejected and leaves no extra D0 record.
    await expect(
      installConnectorFromSource({
        sourceDir: join(builtins, "seed"),
        workspacePath: workspace,
        connectorId: "seed",
        guard,
      }),
    ).rejects.toThrow("Connector already installed: seed");
    expect(
      dataDb.prepare("SELECT COUNT(*) AS n FROM events WHERE type = ?").get("connector.installed"),
    ).toMatchObject({ n: 1 });
  });

  test("reinstall after removal works and D0 keeps the full history", async () => {
    const guard = new Guard({ db: dataDb, source: "system:test" });
    const builtins = join(workspace, "builtins");
    writeBuiltIn(builtins, "seed");
    const installOnce = () =>
      installConnectorFromSource({
        sourceDir: join(builtins, "seed"),
        workspacePath: workspace,
        connectorId: "seed",
        guard,
      });

    await installOnce();
    await supervisor.registerDirectory(join(workspace, "connectors", "seed"));
    expect(supervisor.isRegistered("seed")).toBe(true);

    // The remove-connector flow: delete the folder, then unregister (which
    // records connector.removed in D0). The entry becomes available again.
    expect(await removeInstalledConnector(workspace, "seed")).toBe(true);
    expect(await supervisor.unregister("seed")).toBe(true);
    expect(supervisor.isRegistered("seed")).toBe(false);

    // Nothing restores it implicitly — reinstalling is an explicit action.
    await installOnce();
    await supervisor.registerDirectory(join(workspace, "connectors", "seed"));
    expect(existsSync(join(workspace, "connectors", "seed", "index.mjs"))).toBe(true);

    const history = dataDb
      .prepare(
        "SELECT type, COUNT(*) AS n FROM events WHERE type LIKE 'connector.%' GROUP BY type ORDER BY type",
      )
      .all() as Array<{ type: string; n: number }>;
    expect(history).toEqual([
      { type: "connector.installed", n: 2 },
      { type: "connector.removed", n: 1 },
    ]);
  });

  test("loads connector runtime from directory entry", async () => {
    const dir = join(workspace, "connectors", "demo");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "connector.yaml"),
      `id: demo
name: Demo
entry: ./index.mjs
runtime:
  mode: manual
integrations:
  mode: singleton
platforms:
  darwin: {}
auth:
  type: none
`,
    );
    writeFileSync(
      join(dir, "index.mjs"),
      `export default {
  async run({ guard, state }) {
    await guard.writeEvent({
      type: "demo.event",
      externalId: "loaded",
      startedAt: 5000,
      payload: { loaded: true },
    });
    await state.set({ loaded: true });
  },
};
`,
    );

    const manifest = await supervisor.registerDirectory(dir);
    const integration = supervisor.ensureIntegration({ connectorId: manifest.id });
    await expect(supervisor.run(integration.id)).rejects.toThrow("not trusted");
    await supervisor.approveCurrentPackage("demo");
    await supervisor.run(integration.id);

    const event = dataDb.prepare("SELECT source, type, external_id FROM events WHERE type = ?")
      .get("demo.event") as any;
    expect(event).toEqual({
      source: "connector:demo",
      type: "demo.event",
      external_id: "loaded",
    });
    expect(supervisor.getIntegration(integration.id)?.syncState).toEqual({ loaded: true });
  });

  test("manages integration lifecycle: connect with token, toggle, remove", async () => {
    supervisor.register(
      {
        id: "managed-feed",
        name: "Managed Feed",
        entry: "./index.ts",
        runtime: { mode: "poll" },
        integrations: { mode: "multiple" },
        auth: { type: "apiKey" },
      },
      { async run() {} },
    );

    const integration = supervisor.ensureIntegration({
      connectorId: "managed-feed",
      integrationKey: "work",
    });
    expect(integration.setupStatus).toBe("setup");

    // apiKey connect stores the token and promotes through the evaluator.
    await expect(
      supervisor.connectIntegrationWithToken(integration.id, "  ")
    ).rejects.toThrow("non-empty token");
    const connected = await supervisor.connectIntegrationWithToken(integration.id, "tok-1");
    expect(connected.setupStatus).toBe("ready");
    expect(await supervisor.getAuthManager().hasToken(connected.authRef!)).toBe(true);

    // Enable toggle through updateIntegration.
    const disabled = supervisor.updateIntegration(integration.id, { enabled: false });
    expect(disabled.status).toBe("disabled");
    const enabled = supervisor.updateIntegration(integration.id, { enabled: true });
    expect(enabled.status).toBe("idle");

    // Remove purges credentials and deletes the row.
    await supervisor.removeIntegration(integration.id);
    expect(supervisor.getIntegration(integration.id)).toBeUndefined();
    expect(await supervisor.getAuthManager().hasToken(connected.authRef!)).toBe(false);

    // Deleting the last integration keeps a fresh management entry so the
    // installed connector does not vanish from the console.
    const placeholder = (await supervisor.list()).find((c) => c.connectorId === "managed-feed");
    expect(placeholder).toBeDefined();
    expect(placeholder?.integrationKey).toBeUndefined();
    expect(placeholder?.setupStatus).toBe("setup");
  });

  test("rejects oauth2 token connect because oauth uses the browser flow", async () => {
    supervisor.register(
      {
        id: "oauth-feed",
        name: "OAuth Feed",
        entry: "./index.ts",
        runtime: { mode: "poll" },
        integrations: { mode: "singleton" },
        auth: {
          type: "oauth2",
          authorizationEndpoint: "https://accounts.google.com/o/oauth2/v2/auth",
          tokenEndpoint: "https://oauth2.googleapis.com/token",
          clientId: "feed-client-id",
        },
      },
      { async run() {} },
    );
    const integration = supervisor.ensureIntegration({ connectorId: "oauth-feed" });
    await expect(
      supervisor.connectIntegrationWithToken(integration.id, "tok")
    ).rejects.toThrow("oauth2");
  });

  test("oauth callback binds auth_ref to first-connect setup rows", async () => {
    supervisor = new ConnectorSupervisor({
      systemDb,
      guard: new Guard({ db: dataDb, source: "system:test" }),
      host: { workspacePath: workspace },
      platform: "darwin",
      authManager: new ConnectorAuthManager(secrets, {
        fetchImpl: async () => new Response(JSON.stringify({
          access_token: "access-token",
          refresh_token: "refresh-token",
          expires_in: 3600,
        }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      }),
    });
    supervisor.register(
      {
        id: "oauth-bind",
        name: "OAuth Bind",
        entry: "./index.ts",
        runtime: { mode: "poll" },
        integrations: { mode: "singleton" },
        auth: {
          type: "oauth2",
          authorizationEndpoint: "https://accounts.google.com/o/oauth2/v2/auth",
          tokenEndpoint: "https://oauth2.googleapis.com/token",
          clientId: "feed-client-id",
        },
      },
      { async run() {} },
    );
    const integration = supervisor.ensureIntegration({ connectorId: "oauth-bind" });
    systemDb.prepare("UPDATE connector_integrations SET auth_ref = NULL WHERE id = ?").run(integration.id);
    expect(supervisor.getIntegration(integration.id)?.authRef).toBeUndefined();

    const started = supervisor.startOAuthIntegration(integration.id, {
      redirectUri: "http://127.0.0.1:32123/oauth/callback",
    });
    const state = new URL(started.authorizationUrl).searchParams.get("state")!;
    await expect(supervisor.completeOAuthCallback(new URLSearchParams({ state, code: "code-1" })))
      .resolves.toMatchObject({ status: "connected", integrationId: integration.id });

    const connected = supervisor.getIntegration(integration.id)!;
    expect(connected.authRef).toBe(`connector-integration:${integration.id}:auth`);
    expect(connected.setupStatus).toBe("ready");
    expect(await supervisor.getAuthManager().hasToken(connected.authRef!)).toBe(true);
  });

  test("emits D0 audit events for connector approve and remove", async () => {
    const dir = join(workspace, "connectors", "audited");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "connector.yaml"),
      `id: audited
name: Audited
entry: ./index.mjs
runtime:
  mode: manual
integrations:
  mode: singleton
platforms:
  darwin: {}
auth:
  type: none
`,
    );
    writeFileSync(join(dir, "index.mjs"), "export default { async run() {} };\n");

    await supervisor.registerDirectory(dir);
    supervisor.ensureFirstIntegration("audited");
    await supervisor.approveCurrentPackage("audited");

    const approved = dataDb
      .prepare("SELECT source, payload FROM events WHERE type = ?")
      .get("connector.approved") as any;
    expect(approved.source).toBe("system:test");
    const approvedPayload = JSON.parse(approved.payload);
    expect(approvedPayload.connector_id).toBe("audited");
    expect(approvedPayload.approved_hash).toMatch(/^sha256:/);
    const approvalState = systemDb
      .prepare("SELECT approved_hash FROM connector_custom_approvals WHERE connector_id = ?")
      .get("audited") as { approved_hash: string };
    expect(approvalState.approved_hash).toBe(approvedPayload.approved_hash);

    expect(await supervisor.unregister("audited")).toBe(true);
    const removed = dataDb
      .prepare("SELECT source, payload FROM events WHERE type = ?")
      .get("connector.removed") as any;
    expect(removed.source).toBe("system:test");
    expect(JSON.parse(removed.payload)).toEqual({ connector_id: "audited" });

    // Integration row survives as non-runnable with missing trust.
    const after = (await supervisor.list()).find((c) => c.connectorId === "audited");
    expect(after?.trustStatus).toBe("missing");
    expect(after?.supported).toBe(false);
  });

  test("runs workspace package connectors in a separate runner process", async () => {
    const dir = join(workspace, "connectors", "pid-probe");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "connector.yaml"),
      `id: pid-probe
name: PID Probe
entry: ./index.mjs
runtime:
  mode: manual
integrations:
  mode: singleton
platforms:
  darwin: {}
auth:
  type: none
`,
    );
    writeFileSync(
      join(dir, "index.mjs"),
      `export default {
  async run({ guard, state, config }) {
    await guard.writeEvent({
      type: "pid.sample",
      externalId: "pid",
      startedAt: 1,
      payload: { pid: process.pid, configType: typeof config },
    });
    await state.set({ pid: process.pid });
  },
};
`,
    );

    await supervisor.registerDirectory(dir);
    const integration = supervisor.ensureFirstIntegration("pid-probe");
    await supervisor.approveCurrentPackage("pid-probe");
    await supervisor.run(integration.id);

    const event = dataDb.prepare("SELECT payload FROM events WHERE type = ?").get("pid.sample") as any;
    const payload = JSON.parse(event.payload);
    expect(typeof payload.pid).toBe("number");
    // The whole point: connector code did not execute in this process.
    expect(payload.pid).not.toBe(process.pid);
    // mergeConfig normalizes absent config to {} on both runner paths; the
    // process boundary must not degrade it to null.
    expect(payload.configType).toBe("object");
    expect(supervisor.getIntegration(integration.id)?.syncState).toEqual({ pid: payload.pid });
  });

  test("force-kills runner processes that ignore abort", async () => {
    const fastKillSupervisor = new ConnectorSupervisor({
      systemDb,
      guard: new Guard({ db: dataDb, source: "system:test" }),
      host: { workspacePath: workspace },
      platform: "darwin",
      runnerKillGraceMs: 150,
    });
    const dir = join(workspace, "connectors", "stubborn");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "connector.yaml"),
      `id: stubborn
name: Stubborn
entry: ./index.mjs
runtime:
  mode: watch
integrations:
  mode: singleton
platforms:
  darwin: {}
auth:
  type: none
`,
    );
    writeFileSync(
      join(dir, "index.mjs"),
      `// Survives polite kills: ignores both the abort signal and SIGTERM.
process.on("SIGTERM", () => {});
export default {
  async run() {
    await new Promise(() => {});
  },
};
`,
    );

    await fastKillSupervisor.registerDirectory(dir);
    const integration = fastKillSupervisor.ensureFirstIntegration("stubborn");
    await fastKillSupervisor.approveCurrentPackage("stubborn");

    const handle = fastKillSupervisor.start(integration.id);
    await new Promise((resolve) => setTimeout(resolve, 300));
    handle.abort();
    const settled = await waitWithTestTimeout(handle.promise, 3_000);
    expect(settled).toBe(true);
    expect(fastKillSupervisor.getIntegration(integration.id)?.status).toBe("idle");
  });

  test("package runner abort is cooperative: the connector cleans up before any kill", async () => {
    const dir = join(workspace, "connectors", "tidy");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "connector.yaml"),
      `id: tidy
name: Tidy
entry: ./index.mjs
runtime:
  mode: watch
integrations:
  mode: singleton
platforms:
  darwin: {}
auth:
  type: none
`,
    );
    writeFileSync(
      join(dir, "index.mjs"),
      `export default {
  async run({ guard, state, signal }) {
    await guard.writeEvent({ type: "tidy.start", externalId: "start", startedAt: 1, payload: {} });
    await new Promise((resolve) => {
      if (signal.aborted) return resolve();
      signal.addEventListener("abort", () => resolve(), { once: true });
    });
    await state.set({ cleanedUp: true });
  },
};
`,
    );

    await supervisor.registerDirectory(dir);
    const integration = supervisor.ensureFirstIntegration("tidy");
    await supervisor.approveCurrentPackage("tidy");

    const handle = supervisor.start(integration.id);
    const started = await waitWithTestTimeout(
      (async () => {
        while (!dataDb.prepare("SELECT id FROM events WHERE type = ?").get("tidy.start")) {
          await new Promise((resolve) => setTimeout(resolve, 25));
        }
      })(),
      5_000,
    );
    expect(started).toBe(true);

    handle.abort();
    const settled = await waitWithTestTimeout(handle.promise, 3_000);
    expect(settled).toBe(true);
    // The cleanup write only lands if abort stayed cooperative — an immediate
    // SIGKILL would have killed the child before state.set.
    expect(supervisor.getIntegration(integration.id)?.syncState).toEqual({ cleanedUp: true });
    expect(supervisor.getIntegration(integration.id)?.status).toBe("idle");
  });

  test("kills runner processes that hang during top-level import", async () => {
    const hangSupervisor = new ConnectorSupervisor({
      systemDb,
      guard: new Guard({ db: dataDb, source: "system:test" }),
      host: { workspacePath: workspace },
      platform: "darwin",
      runnerCommandTimeoutMs: 300,
    });
    const dir = join(workspace, "connectors", "import-hang");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "connector.yaml"),
      `id: import-hang
name: Import Hang
entry: ./index.mjs
runtime:
  mode: poll
  defaultSchedule: "*/15 * * * *"
integrations:
  mode: singleton
platforms:
  darwin: {}
auth:
  type: none
`,
    );
    writeFileSync(
      join(dir, "index.mjs"),
      `await new Promise(() => {}); // top-level hang
export default { async run() {} };
`,
    );

    await hangSupervisor.registerDirectory(dir);
    const integration = hangSupervisor.ensureFirstIntegration("import-hang");
    await hangSupervisor.approveCurrentPackage("import-hang");

    // Bounded by runnerCommandTimeoutMs: the hanging import is killed and the
    // run fails instead of waiting forever.
    await expect(hangSupervisor.run(integration.id)).rejects.toThrow("timed out");
    expect(hangSupervisor.getIntegration(integration.id)?.status).toBe("error");
  });

  test("isolates runner process crashes from the core", async () => {
    const dir = join(workspace, "connectors", "crasher");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "connector.yaml"),
      `id: crasher
name: Crasher
entry: ./index.mjs
runtime:
  mode: poll
  defaultSchedule: "*/15 * * * *"
integrations:
  mode: singleton
platforms:
  darwin: {}
auth:
  type: none
`,
    );
    writeFileSync(
      join(dir, "index.mjs"),
      `export default {
  async run() {
    process.exit(7);
  },
};
`,
    );

    await supervisor.registerDirectory(dir);
    const integration = supervisor.ensureFirstIntegration("crasher");
    await supervisor.approveCurrentPackage("crasher");

    await expect(supervisor.run(integration.id)).rejects.toThrow("exited unexpectedly");
    const stored = supervisor.getIntegration(integration.id);
    expect(stored?.status).toBe("error");
    expect(stored?.lastError).toContain("exited unexpectedly");
  });

  test("rejects connector entries outside connector directory", () => {
    expect(() => resolveConnectorEntry("/tmp/connector", "../outside.mjs")).toThrow("inside connector directory");
  });

  test("uses the connector source namespace helper", () => {
    expect(sourceForConnector("terminal")).toBe("connector:terminal");
    expect(sourceForConnector("calendar", "work")).toBe("connector:calendar:work");
    expect(() => sourceForConnector("../terminal")).toThrow("Invalid connector id");
  });
});
