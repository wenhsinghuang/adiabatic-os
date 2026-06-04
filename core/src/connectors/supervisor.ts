import type { Database } from "bun:sqlite";
import { pathToFileURL } from "url";
import { isAbsolute, relative, resolve } from "path";
import type { Guard } from "../guard";
import { ConnectorAuthManager } from "./auth";
import { createBoundConnectorGuard, sourceForConnector } from "./guard";
import {
  currentConnectorPlatform,
  isPlatformSupported,
  loadConnectorManifest,
  validateConnectorId,
  validateConnectorManifest,
} from "./manifest";
import { ConnectorRuntime, validateConnectorDefinition } from "./runtime";
import {
  ConnectorIntegrationStore,
  createConnectorStateHandle,
  defaultAuthRef,
  type EnsureIntegrationInput,
} from "./state";
import type {
  ConnectorDefinition,
  ConnectorIntegration,
  ConnectorManifest,
  ConnectorPlatform,
  ConnectorRunHandle,
} from "./types";

interface Registration {
  manifest: ConnectorManifest;
  definition: ConnectorDefinition;
  dir?: string;
}

interface ActiveRun {
  instanceId: string;
  controller: AbortController;
  promise: Promise<void>;
}

export interface ConnectorSupervisorOptions {
  db: Database;
  guard: Guard;
  platform?: ConnectorPlatform;
  authManager?: ConnectorAuthManager;
}

export class ConnectorSupervisor {
  private registrations = new Map<string, Registration>();
  private activeRuns = new Map<string, ActiveRun>();
  private store: ConnectorIntegrationStore;
  private authManager: ConnectorAuthManager;
  private platform: ConnectorPlatform;
  private guard: Guard;

  constructor(opts: ConnectorSupervisorOptions) {
    this.guard = opts.guard;
    this.store = new ConnectorIntegrationStore(opts.db);
    this.authManager = opts.authManager ?? new ConnectorAuthManager();
    this.platform = opts.platform ?? currentConnectorPlatform();
  }

  register<TConfig = unknown, TState = unknown>(
    manifest: ConnectorManifest<TConfig>,
    definition: ConnectorDefinition<TConfig, TState>,
    opts?: { dir?: string },
  ): void {
    const normalized = validateConnectorManifest(manifest as ConnectorManifest);
    validateConnectorDefinition(definition as ConnectorDefinition);
    if (this.registrations.has(normalized.id)) {
      throw new Error(`Connector already registered: ${normalized.id}`);
    }
    this.registrations.set(normalized.id, {
      manifest: normalized,
      definition: definition as ConnectorDefinition,
      dir: opts?.dir,
    });
  }

  async registerDirectory(connectorDir: string): Promise<ConnectorManifest> {
    const manifest = await loadConnectorManifest(connectorDir);
    const definition = await loadConnectorDefinition(resolveConnectorEntry(connectorDir, manifest.entry));
    this.register(manifest, definition, { dir: connectorDir });
    return manifest;
  }

  ensureIntegration<TConfig = unknown, TState = unknown>(
    input: EnsureIntegrationInput<TConfig>,
  ): ConnectorIntegration<TConfig, TState> {
    const registration = this.requireRegistration(input.connectorId);
    if (!isPlatformSupported(registration.manifest, this.platform)) {
      throw new Error(`Connector ${input.connectorId} is not supported on ${this.platform}`);
    }
    return this.store.ensure<TConfig, TState>({
      ...input,
      authRef: input.authRef ?? defaultAuthRef(input.id ?? input.connectorId),
    });
  }

  list(): Array<ConnectorIntegration & {
    name: string;
    mode: string;
    source: string;
    running: boolean;
    supported: boolean;
  }> {
    return this.store.list().map((integration) => {
      const registration = this.registrations.get(integration.connectorId);
      return {
        ...integration,
        name: registration?.manifest.name ?? integration.connectorId,
        mode: registration?.manifest.runtime.mode ?? "unknown",
        source: sourceForConnector(integration.id),
        running: this.activeRuns.has(integration.id),
        supported: registration ? isPlatformSupported(registration.manifest, this.platform) : false,
      };
    });
  }

  async run(instanceId: string, opts?: { config?: unknown }): Promise<void> {
    const active = this.createRun(instanceId, opts);
    await active.promise;
  }

  start(instanceId: string, opts?: { config?: unknown }): ConnectorRunHandle {
    const active = this.createRun(instanceId, opts);
    return {
      instanceId,
      signal: active.controller.signal,
      promise: active.promise,
      abort: () => active.controller.abort(),
    };
  }

  abort(instanceId: string): void {
    this.activeRuns.get(instanceId)?.controller.abort();
  }

  getIntegration<TConfig = unknown, TState = unknown>(
    instanceId: string,
  ): ConnectorIntegration<TConfig, TState> | undefined {
    return this.store.get<TConfig, TState>(instanceId);
  }

  getAuthManager(): ConnectorAuthManager {
    return this.authManager;
  }

  private createRun(instanceId: string, opts?: { config?: unknown }): ActiveRun {
    validateConnectorId(instanceId);
    if (this.activeRuns.has(instanceId)) {
      throw new Error(`Connector instance already running: ${instanceId}`);
    }

    const integration = this.store.get(instanceId);
    if (!integration) {
      throw new Error(`Connector integration not found: ${instanceId}`);
    }
    if (!integration.enabled || integration.status === "disabled") {
      throw new Error(`Connector integration is disabled: ${instanceId}`);
    }

    const registration = this.requireRegistration(integration.connectorId);
    if (!isPlatformSupported(registration.manifest, this.platform)) {
      throw new Error(`Connector ${integration.connectorId} is not supported on ${this.platform}`);
    }

    const controller = new AbortController();
    this.store.setStatus(instanceId, "running");

    const context = {
      guard: createBoundConnectorGuard(this.guard, instanceId),
      auth: this.authManager.createHandle(registration.manifest.auth ?? { type: "none" }, integration),
      state: createConnectorStateHandle(this.store, instanceId),
      config: mergeConfig(registration.manifest.config, integration.config, opts?.config),
      signal: controller.signal,
    };
    const runtime = new ConnectorRuntime({
      definition: registration.definition,
      context,
    });

    const promise = (async () => {
      try {
        await runtime.run();
        this.store.setStatus(instanceId, "idle");
      } catch (err) {
        if (controller.signal.aborted) {
          this.store.setStatus(instanceId, "idle");
          return;
        }
        const message = err instanceof Error ? err.message : String(err);
        this.store.setStatus(instanceId, "error", message);
        throw err;
      } finally {
        this.activeRuns.delete(instanceId);
      }
    })();
    promise.catch(() => {});

    const active = { instanceId, controller, promise };
    this.activeRuns.set(instanceId, active);
    return active;
  }

  private requireRegistration(connectorId: string): Registration {
    validateConnectorId(connectorId);
    const registration = this.registrations.get(connectorId);
    if (!registration) {
      throw new Error(`Connector is not registered: ${connectorId}`);
    }
    return registration;
  }
}

async function loadConnectorDefinition(entryPath: string): Promise<ConnectorDefinition> {
  const mod = await import(pathToFileURL(entryPath).href);
  const definition = mod.default ?? mod.connector;
  validateConnectorDefinition(definition);
  return definition;
}

export function resolveConnectorEntry(connectorDir: string, entry: string): string {
  const root = resolve(connectorDir);
  const target = resolve(root, entry);
  const rel = relative(root, target);
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) {
    throw new Error(`Connector entry must stay inside connector directory: ${entry}`);
  }
  return target;
}

function mergeConfig(...configs: unknown[]): unknown {
  const objects = configs.filter(isObject) as Record<string, unknown>[];
  if (objects.length === configs.filter((value) => value !== undefined).length) {
    return Object.assign({}, ...objects);
  }
  const last = [...configs].reverse().find((value) => value !== undefined);
  return last;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
