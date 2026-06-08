import type { Database } from "bun:sqlite";
import { pathToFileURL } from "url";
import type { Guard } from "../guard";
import { ConnectorAuthManager } from "./auth";
import { createBoundConnectorGuard, sourceForConnector } from "./guard";
import {
  currentConnectorPlatform,
  isPlatformSupported,
  validateConnectorId,
  validateConnectorManifest,
} from "./manifest";
import { WorkspaceConnectorRegistry, trustStatusForIntegration } from "./registry";
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
  ConnectorOfficialCatalogEntry,
  ConnectorPackageRecord,
  ConnectorPackageTrust,
  ConnectorPlatform,
  ConnectorRunHandle,
} from "./types";

interface Registration {
  manifest: ConnectorManifest;
  definition?: ConnectorDefinition;
  package?: ConnectorPackageRecord;
  trust: ConnectorPackageTrust;
}

interface ActiveRun {
  instanceId: string;
  controller: AbortController;
  signal: AbortSignal;
  promise: Promise<void>;
  abort(): void;
}

export interface ConnectorSupervisorOptions {
  db: Database;
  guard: Guard;
  platform?: ConnectorPlatform;
  authManager?: ConnectorAuthManager;
  officialCatalog?: ConnectorOfficialCatalogEntry[];
}

const MANUAL_TRUST: ConnectorPackageTrust = {
  status: "custom",
  badge: "Custom",
  runnable: true,
};

export class ConnectorSupervisor {
  private registrations = new Map<string, Registration>();
  private activeRuns = new Map<string, ActiveRun>();
  private store: ConnectorIntegrationStore;
  private authManager: ConnectorAuthManager;
  private platform: ConnectorPlatform;
  private guard: Guard;
  private registry: WorkspaceConnectorRegistry;

  constructor(opts: ConnectorSupervisorOptions) {
    this.guard = opts.guard;
    this.store = new ConnectorIntegrationStore(opts.db);
    this.authManager = opts.authManager ?? new ConnectorAuthManager();
    this.platform = opts.platform ?? currentConnectorPlatform();
    this.registry = new WorkspaceConnectorRegistry({
      db: opts.db,
      officialCatalog: opts.officialCatalog ?? [],
    });
  }

  register<TConfig = unknown, TState = unknown>(
    manifest: ConnectorManifest<TConfig>,
    definition: ConnectorDefinition<TConfig, TState>,
  ): void {
    const normalized = validateConnectorManifest(manifest as ConnectorManifest);
    validateConnectorDefinition(definition as ConnectorDefinition);
    if (this.registrations.has(normalized.id)) {
      throw new Error(`Connector already registered: ${normalized.id}`);
    }
    this.registrations.set(normalized.id, {
      manifest: normalized,
      definition: definition as ConnectorDefinition,
      trust: MANUAL_TRUST,
    });
  }

  async registerDirectory(connectorDir: string): Promise<ConnectorManifest> {
    const pkg = await this.registry.loadPackage(connectorDir);
    if (this.registrations.has(pkg.connectorId)) {
      throw new Error(`Connector already registered: ${pkg.connectorId}`);
    }
    this.registrations.set(pkg.connectorId, {
      manifest: pkg.manifest,
      package: pkg,
      trust: pkg.trust,
    });
    this.store.setTrustForConnector(
      pkg.connectorId,
      trustStatusForIntegration(pkg.trust),
      pkg.contentHash,
    );
    return pkg.manifest;
  }

  async approveCurrentPackage(connectorId: string): Promise<ConnectorManifest> {
    const registration = this.requireRegistration(connectorId);
    if (!registration.package) {
      throw new Error(`Connector ${connectorId} was not loaded from a workspace package`);
    }
    const current = await this.registry.loadPackage(registration.package.dir);
    const approved = this.registry.approveCustomPackage(current);
    this.registrations.set(connectorId, {
      ...registration,
      manifest: approved.manifest,
      package: approved,
      trust: approved.trust,
    });
    this.store.setTrustForConnector(
      connectorId,
      trustStatusForIntegration(approved.trust),
      approved.contentHash,
    );
    return approved.manifest;
  }

  ensureIntegration<TConfig = unknown, TState = unknown>(
    input: EnsureIntegrationInput<TConfig>,
  ): ConnectorIntegration<TConfig, TState> {
    const registration = this.requireRegistration(input.connectorId);
    if (!isPlatformSupported(registration.manifest, this.platform)) {
      throw new Error(`Connector ${input.connectorId} is not supported on ${this.platform}`);
    }

    const mode = registration.manifest.integrations?.mode ?? "singleton";
    if (mode === "singleton" && input.integrationKey) {
      throw new Error(`Connector ${input.connectorId} supports only one integration`);
    }
    const setupStatus = input.setupStatus ?? (mode === "multiple" && !input.integrationKey ? "setup" : "ready");
    const scheduleCron = input.scheduleCron === undefined
      ? registration.manifest.runtime.defaultSchedule
      : input.scheduleCron ?? undefined;
    const packageHash = input.packageHash ?? registration.package?.contentHash;
    const trustStatus = input.trustStatus ?? trustStatusForIntegration(registration.trust);

    return this.store.ensure<TConfig, TState>({
      ...input,
      setupStatus,
      scheduleCron,
      packageHash,
      trustStatus,
      authRef: input.authRef ?? defaultAuthRef(input.connectorId, input.integrationKey),
    });
  }

  ensureFirstIntegration(connectorId: string): ConnectorIntegration {
    const registration = this.requireRegistration(connectorId);
    return this.ensureIntegration({
      connectorId,
      setupStatus: registration.manifest.integrations?.mode === "multiple" ? "setup" : "ready",
    });
  }

  list(): Array<ConnectorIntegration & {
    name: string;
    mode: string;
    source: string | undefined;
    running: boolean;
    supported: boolean;
    packageTrust: ConnectorPackageTrust["status"];
  }> {
    return this.store.list().map((integration) => {
      const registration = this.registrations.get(integration.connectorId);
      const hasSourceIdentity = Boolean(
        integration.integrationKey || registration?.manifest.integrations?.mode !== "multiple",
      );
      return {
        ...integration,
        name: registration?.manifest.name ?? integration.connectorId,
        mode: registration?.manifest.runtime.mode ?? "unknown",
        source: hasSourceIdentity
          ? sourceForConnector(integration.connectorId, integration.integrationKey)
          : undefined,
        running: this.activeRuns.has(integration.id),
        supported: registration ? isPlatformSupported(registration.manifest, this.platform) : false,
        packageTrust: registration?.trust.status ?? "missing",
      };
    });
  }

  async run(instanceId: string, opts?: { config?: unknown }): Promise<void> {
    const active = this.createRun(instanceId, opts);
    await active.promise;
  }

  start(instanceId: string, opts?: { config?: unknown }): ConnectorRunHandle {
    return this.createRun(instanceId, opts);
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
    if (this.activeRuns.has(instanceId)) {
      throw new Error(`Connector integration already running: ${instanceId}`);
    }

    const integration = this.store.get(instanceId);
    if (!integration) {
      throw new Error(`Connector integration not found: ${instanceId}`);
    }
    if (!integration.enabled || integration.status === "disabled") {
      throw new Error(`Connector integration is disabled: ${instanceId}`);
    }
    if (integration.setupStatus !== "ready" || integration.status === "setup") {
      throw new Error(`Connector integration is not set up: ${instanceId}`);
    }

    const registration = this.requireRegistration(integration.connectorId);
    const mode = registration.manifest.integrations?.mode ?? "singleton";
    if (mode === "multiple" && !integration.integrationKey) {
      throw new Error(`Connector integration requires an integration_key: ${instanceId}`);
    }
    if (!isPlatformSupported(registration.manifest, this.platform)) {
      throw new Error(`Connector ${integration.connectorId} is not supported on ${this.platform}`);
    }

    const controller = new AbortController();
    this.store.setStatus(instanceId, "running");

    const promise = (async () => {
      try {
        const definition = await this.loadTrustedDefinition(registration);
        const context = {
          guard: createBoundConnectorGuard(this.guard, integration.connectorId, integration.integrationKey),
          auth: this.authManager.createHandle(registration.manifest.auth ?? { type: "none" }, integration),
          state: createConnectorStateHandle(this.store, instanceId),
          config: mergeConfig(registration.manifest.config, integration.config, opts?.config),
          signal: controller.signal,
        };
        const runtime = new ConnectorRuntime({
          definition,
          context,
        });
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

    const active = {
      instanceId,
      controller,
      signal: controller.signal,
      promise,
      abort: () => controller.abort(),
    };
    this.activeRuns.set(instanceId, active);
    return active;
  }

  private async loadTrustedDefinition(registration: Registration): Promise<ConnectorDefinition> {
    if (!registration.package) {
      if (registration.definition) return registration.definition;
      throw new Error(`Connector ${registration.manifest.id} has no package entry`);
    }

    const previousHash = registration.package.contentHash;
    const current = await this.registry.loadPackage(registration.package.dir);
    registration.manifest = current.manifest;
    registration.package = current;
    registration.trust = current.trust;
    this.store.setTrustForConnector(
      current.connectorId,
      trustStatusForIntegration(current.trust),
      current.contentHash,
    );

    if (!current.trust.runnable) {
      throw new Error(`Connector ${current.connectorId} is not trusted: ${current.trust.status}`);
    }

    if (registration.definition && previousHash === current.contentHash) {
      return registration.definition;
    }

    const definition = await loadConnectorDefinition(current.entryPath, current.contentHash);
    registration.definition = definition;
    return definition;
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

async function loadConnectorDefinition(entryPath: string, contentHash?: string): Promise<ConnectorDefinition> {
  const url = pathToFileURL(entryPath);
  if (contentHash) {
    url.searchParams.set("hash", contentHash);
  }
  const mod = await import(url.href);
  const definition = mod.default ?? mod.connector;
  validateConnectorDefinition(definition);
  return definition;
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
