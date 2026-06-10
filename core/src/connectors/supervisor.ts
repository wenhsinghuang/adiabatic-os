import type { Database } from "bun:sqlite";
import { pathToFileURL } from "url";
import type { Guard } from "../guard";
import { ConnectorAuthManager } from "./auth";
import { createBoundConnectorGuard, sourceForConnector } from "./guard";
import {
  activePlatformRequirements,
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
  type EnsureIntegrationInput,
  type UpdateIntegrationInput,
} from "./state";
import { validateConnectorSchedule } from "./schedule";
import type {
  ConnectorDefinition,
  ConnectorHostContext,
  ConnectorIntegration,
  ConnectorManifest,
  ConnectorOfficialCatalogEntry,
  ConnectorPackageRecord,
  ConnectorPackageTrust,
  ConnectorPlatform,
  ConnectorRequirementContext,
  ConnectorRequirementRecord,
  ConnectorRequirementState,
  ConnectorRequirementStatus,
  ConnectorRunHandle,
} from "./types";

export interface ConnectorRequirementView {
  id: string;
  status: ConnectorRequirementState | "unknown";
  message?: string;
  lastCheckedAt?: number;
}

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
  host: ConnectorHostContext;
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
  private host: ConnectorHostContext;
  private registry: WorkspaceConnectorRegistry;

  constructor(opts: ConnectorSupervisorOptions) {
    this.guard = opts.guard;
    this.host = opts.host;
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
    const existingForIdentity = input.id
      ? this.store.get(input.id)
      : this.store.getByIdentity(input.connectorId, input.integrationKey || undefined);
    const setupStatus = validateIntegrationLifecycle({
      connectorId: input.connectorId,
      mode,
      integrationKey: input.integrationKey,
      setupStatus: input.setupStatus,
      requiresAuth: (registration.manifest.auth ?? { type: "none" }).type !== "none",
      authReady: false,
      requirementsSatisfied: this.requirementsSatisfiedFor(registration.manifest, existingForIdentity),
    });
    const scheduleCron = input.scheduleCron === undefined
      ? registration.manifest.runtime.defaultSchedule
      : input.scheduleCron ?? undefined;
    if (scheduleCron !== undefined) {
      validateConnectorSchedule(scheduleCron);
    }
    const packageHash = input.packageHash ?? registration.package?.contentHash;
    const trustStatus = input.trustStatus ?? trustStatusForIntegration(registration.trust);

    return this.store.ensure<TConfig, TState>({
      ...input,
      setupStatus,
      scheduleCron,
      packageHash,
      trustStatus,
    });
  }

  updateIntegration<TConfig = unknown, TState = unknown>(
    instanceId: string,
    input: UpdateIntegrationInput<TConfig>,
  ): ConnectorIntegration<TConfig, TState> {
    const existing = this.store.get(instanceId);
    if (!existing) {
      throw new Error(`Connector integration not found: ${instanceId}`);
    }
    const registration = this.requireRegistration(existing.connectorId);
    if (!isPlatformSupported(registration.manifest, this.platform)) {
      throw new Error(`Connector ${existing.connectorId} is not supported on ${this.platform}`);
    }
    if (input.authRef !== undefined && input.authRef !== existing.authRef) {
      throw new Error(`Connector integration ${instanceId} authRef changes must use connectIntegration`);
    }
    validateScheduleInput(input.scheduleCron);
    const mode = registration.manifest.integrations?.mode ?? "singleton";
    const requiresAuth = (registration.manifest.auth ?? { type: "none" }).type !== "none";
    const setupStatus = validateIntegrationLifecycle({
      connectorId: existing.connectorId,
      mode,
      integrationKey: input.integrationKey ?? existing.integrationKey,
      setupStatus: input.setupStatus ?? existing.setupStatus,
      requiresAuth,
      authReady: !requiresAuth || existing.setupStatus === "ready",
      requirementsSatisfied: this.requirementsSatisfiedFor(registration.manifest, existing),
    });
    return this.store.update<TConfig, TState>(instanceId, {
      ...input,
      setupStatus,
    });
  }

  async connectIntegration<TConfig = unknown, TState = unknown>(
    instanceId: string,
    input: UpdateIntegrationInput<TConfig> = {},
  ): Promise<ConnectorIntegration<TConfig, TState>> {
    const existing = this.store.get(instanceId);
    if (!existing) {
      throw new Error(`Connector integration not found: ${instanceId}`);
    }
    const registration = this.requireRegistration(existing.connectorId);
    const auth = registration.manifest.auth ?? { type: "none" };
    if (auth.type === "none") {
      throw new Error(`Connector ${existing.connectorId} does not require auth`);
    }
    if (!isPlatformSupported(registration.manifest, this.platform)) {
      throw new Error(`Connector ${existing.connectorId} is not supported on ${this.platform}`);
    }
    const authRef = input.authRef ?? existing.authRef;
    if (!authRef || !(await this.authManager.hasToken(authRef))) {
      throw new Error(`Connector integration ${instanceId} requires credentials before it can be ready`);
    }
    validateScheduleInput(input.scheduleCron);
    // Validate source identity constraints without forcing ready: connect only
    // binds credentials. The unified evaluator decides ready, so auth can be
    // connected before platform requirements are granted (and vice versa).
    validateIntegrationLifecycle({
      connectorId: existing.connectorId,
      mode: registration.manifest.integrations?.mode ?? "singleton",
      integrationKey: input.integrationKey ?? existing.integrationKey,
      setupStatus: "setup",
      requiresAuth: true,
      authReady: true,
      requirementsSatisfied: this.requirementsSatisfiedFor(registration.manifest, existing),
    });
    const { setupStatus: _ignored, ...rest } = input;
    this.store.update(instanceId, {
      ...rest,
      authRef,
    });
    return (await this.refreshSetupStatus(instanceId)) as ConnectorIntegration<TConfig, TState>;
  }

  ensureFirstIntegration(connectorId: string): ConnectorIntegration {
    const registration = this.requireRegistration(connectorId);
    return this.ensureIntegration({
      connectorId,
      setupStatus: firstIntegrationSetupStatus(
        registration.manifest,
        activePlatformRequirements(registration.manifest, this.platform).length > 0,
      ),
    });
  }

  list(): Array<ConnectorIntegration & {
    name: string;
    mode: string;
    source: string | undefined;
    running: boolean;
    supported: boolean;
    packageTrust: ConnectorPackageTrust["status"];
    requirements: ConnectorRequirementView[];
  }> {
    return this.store.list().map((integration) => {
      const registration = this.registrations.get(integration.connectorId);
      const hasSourceIdentity = Boolean(
        integration.integrationKey || registration?.manifest.integrations?.mode !== "multiple",
      );
      const activeRequirements = registration
        ? activePlatformRequirements(registration.manifest, this.platform)
        : [];
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
        requirements: activeRequirements.map((id) => ({
          id,
          status: integration.requirementsStatus?.[id]?.status ?? "unknown",
          message: integration.requirementsStatus?.[id]?.message,
          lastCheckedAt: integration.requirementsStatus?.[id]?.lastCheckedAt,
        })),
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

  async checkIntegrationRequirements(
    instanceId: string,
  ): Promise<Record<string, ConnectorRequirementRecord>> {
    const integration = this.store.get(instanceId);
    if (!integration) {
      throw new Error(`Connector integration not found: ${instanceId}`);
    }
    const registration = this.requireRegistration(integration.connectorId);
    if (!isPlatformSupported(registration.manifest, this.platform)) {
      throw new Error(`Connector ${integration.connectorId} is not supported on ${this.platform}`);
    }
    const requirementIds = activePlatformRequirements(registration.manifest, this.platform);
    if (requirementIds.length === 0) return {};

    // Trust before handler: importing requirement handlers runs connector code,
    // so the package must pass the same trust gate as run().
    const definition = await this.loadTrustedDefinition(registration);
    const records = await this.evaluateRequirements(registration, integration, definition, requirementIds);
    await this.refreshSetupStatus(instanceId);
    return records;
  }

  async requestIntegrationRequirement(
    instanceId: string,
    requirementId: string,
  ): Promise<ConnectorRequirementRecord> {
    const integration = this.store.get(instanceId);
    if (!integration) {
      throw new Error(`Connector integration not found: ${instanceId}`);
    }
    const registration = this.requireRegistration(integration.connectorId);
    const requirementIds = activePlatformRequirements(registration.manifest, this.platform);
    if (!requirementIds.includes(requirementId)) {
      throw new Error(
        `Connector ${integration.connectorId} has no active requirement ${requirementId} on ${this.platform}`,
      );
    }

    const definition = await this.loadTrustedDefinition(registration);
    const handler = definition.requirements?.[requirementId];
    if (!handler) {
      throw new Error(
        `Connector ${integration.connectorId} does not implement requirement handler: ${requirementId}`,
      );
    }

    const ctx = this.requirementContext(integration);
    let requestStatus: ConnectorRequirementStatus | undefined;
    if (handler.request) {
      try {
        requestStatus = normalizeRequirementStatus(await handler.request(ctx));
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const record: ConnectorRequirementRecord = {
          status: "error",
          message,
          lastCheckedAt: Date.now(),
        };
        this.persistRequirementRecords(instanceId, { [requirementId]: record });
        await this.refreshSetupStatus(instanceId);
        return record;
      }
    }

    const records = await this.evaluateRequirements(registration, integration, definition, [requirementId]);
    let record = records[requirementId];
    // check() is the authority for grants, but an in-flight request must stay
    // visible: when request() reports pending (e.g. "grant in System Settings")
    // and the immediate re-check still says missing, keep the pending record so
    // the UI shows the actionable request message instead of a bare missing.
    if (requestStatus?.status === "pending" && record.status === "missing") {
      record = { ...requestStatus, lastCheckedAt: record.lastCheckedAt };
      this.persistRequirementRecords(instanceId, { [requirementId]: record });
    }
    await this.refreshSetupStatus(instanceId);
    return record;
  }

  private requirementContext(integration: ConnectorIntegration): ConnectorRequirementContext {
    return {
      connectorId: integration.connectorId,
      integrationId: integration.id,
      integrationKey: integration.integrationKey,
      platform: this.platform,
      host: this.host,
    };
  }

  private requirementsSatisfiedFor(
    manifest: ConnectorManifest,
    integration: ConnectorIntegration | undefined,
  ): boolean {
    const requirementIds = activePlatformRequirements(manifest, this.platform);
    if (requirementIds.length === 0) return true;
    const status = integration?.requirementsStatus;
    return requirementIds.every((id) => status?.[id]?.status === "satisfied");
  }

  private async evaluateRequirements(
    registration: Registration,
    integration: ConnectorIntegration,
    definition: ConnectorDefinition,
    requirementIds: string[],
  ): Promise<Record<string, ConnectorRequirementRecord>> {
    const ctx = this.requirementContext(integration);
    const updates: Record<string, ConnectorRequirementRecord> = {};
    for (const id of requirementIds) {
      const handler = definition.requirements?.[id];
      let status: ConnectorRequirementStatus;
      if (!handler) {
        status = {
          status: "error",
          message: `Connector ${registration.manifest.id} does not implement requirement handler: ${id}`,
        };
      } else {
        try {
          status = normalizeRequirementStatus(await handler.check(ctx));
        } catch (err) {
          status = {
            status: "error",
            message: err instanceof Error ? err.message : String(err),
          };
        }
      }
      updates[id] = { ...status, lastCheckedAt: Date.now() };
    }
    return this.persistRequirementRecords(integration.id, updates);
  }

  private persistRequirementRecords(
    instanceId: string,
    updates: Record<string, ConnectorRequirementRecord>,
  ): Record<string, ConnectorRequirementRecord> {
    const current = this.store.get(instanceId)?.requirementsStatus ?? {};
    const merged = { ...current, ...updates };
    this.store.setRequirementsStatus(instanceId, merged);
    return merged;
  }

  // Unified setup evaluator: ready requires source identity + auth + active
  // platform requirements all satisfied. Demotes ready integrations whose
  // requirements regressed; promotes setup integrations once everything passes.
  private async refreshSetupStatus(instanceId: string): Promise<ConnectorIntegration> {
    const integration = this.store.get(instanceId);
    if (!integration) {
      throw new Error(`Connector integration not found: ${instanceId}`);
    }
    const registration = this.requireRegistration(integration.connectorId);
    const manifest = registration.manifest;
    const mode = manifest.integrations?.mode ?? "singleton";
    const requiresAuth = (manifest.auth ?? { type: "none" }).type !== "none";

    const sourceReady = mode === "singleton" || Boolean(integration.integrationKey);
    const requirementsReady = this.requirementsSatisfiedFor(manifest, integration);
    const authReady = !requiresAuth
      || Boolean(integration.authRef && (await this.authManager.hasToken(integration.authRef)));
    const eligible = sourceReady && requirementsReady && authReady;

    if (integration.setupStatus === "ready" && !eligible) {
      return this.store.update(instanceId, { setupStatus: "setup" });
    }
    if (integration.setupStatus === "setup" && eligible) {
      return this.store.update(instanceId, { setupStatus: "ready" });
    }
    return integration;
  }

  private async assertRunRequirements(
    registration: Registration,
    integration: ConnectorIntegration,
    definition: ConnectorDefinition,
  ): Promise<void> {
    const requirementIds = activePlatformRequirements(registration.manifest, this.platform);
    if (requirementIds.length === 0) return;

    const records = await this.evaluateRequirements(registration, integration, definition, requirementIds);
    const unsatisfied = requirementIds.filter((id) => records[id]?.status !== "satisfied");
    if (unsatisfied.length > 0) {
      this.store.update(integration.id, { setupStatus: "setup" });
      throw new Error(
        `Connector ${integration.connectorId} requirements not satisfied: ${unsatisfied.join(", ")}`,
      );
    }
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
        await this.assertRunRequirements(registration, integration, definition);
        const context = {
          guard: createBoundConnectorGuard(this.guard, integration.connectorId, integration.integrationKey),
          auth: this.authManager.createHandle(registration.manifest.auth ?? { type: "none" }, integration),
          state: createConnectorStateHandle(this.store, instanceId),
          config: mergeConfig(registration.manifest.config, integration.config, opts?.config),
          host: this.host,
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

function validateIntegrationLifecycle(opts: {
  connectorId: string;
  mode: "singleton" | "multiple";
  integrationKey?: string;
  setupStatus?: "setup" | "ready";
  requiresAuth?: boolean;
  authReady?: boolean;
  requirementsSatisfied?: boolean;
}): "setup" | "ready" {
  const requirementsSatisfied = opts.requirementsSatisfied ?? true;
  if (opts.mode === "singleton") {
    if (opts.integrationKey) {
      throw new Error(`Connector ${opts.connectorId} supports only one integration`);
    }
    const setupStatus = opts.setupStatus
      ?? (opts.requiresAuth || !requirementsSatisfied ? "setup" : "ready");
    if (setupStatus === "ready" && opts.requiresAuth && !opts.authReady) {
      throw new Error(`Connector ${opts.connectorId} integration requires credentials before it can be ready`);
    }
    if (setupStatus === "ready" && !requirementsSatisfied) {
      throw new Error(`Connector ${opts.connectorId} integration requires platform requirements before it can be ready`);
    }
    return setupStatus;
  }

  const setupStatus = opts.setupStatus
    ?? (opts.integrationKey && !opts.requiresAuth && requirementsSatisfied ? "ready" : "setup");
  if (setupStatus === "ready" && !opts.integrationKey) {
    throw new Error(`Connector ${opts.connectorId} integration requires an integration_key before it can be ready`);
  }
  if (setupStatus === "ready" && opts.requiresAuth && !opts.authReady) {
    throw new Error(`Connector ${opts.connectorId} integration requires credentials before it can be ready`);
  }
  if (setupStatus === "ready" && !requirementsSatisfied) {
    throw new Error(`Connector ${opts.connectorId} integration requires platform requirements before it can be ready`);
  }
  return setupStatus;
}

function firstIntegrationSetupStatus(
  manifest: ConnectorManifest,
  hasActiveRequirements: boolean,
): "setup" | "ready" {
  if (manifest.integrations?.mode === "multiple") return "setup";
  if (hasActiveRequirements) return "setup";
  return (manifest.auth ?? { type: "none" }).type === "none" ? "ready" : "setup";
}

function normalizeRequirementStatus(status: ConnectorRequirementStatus): ConnectorRequirementStatus {
  const valid = new Set<ConnectorRequirementState>(["satisfied", "missing", "pending", "error"]);
  if (!status || !valid.has(status.status)) {
    return {
      status: "error",
      message: `Requirement handler returned an invalid status: ${JSON.stringify(status)}`,
    };
  }
  return {
    status: status.status,
    message: typeof status.message === "string" ? status.message : undefined,
  };
}

function validateScheduleInput(scheduleCron: string | null | undefined): void {
  if (scheduleCron !== undefined && scheduleCron !== null) {
    validateConnectorSchedule(scheduleCron);
  }
}
