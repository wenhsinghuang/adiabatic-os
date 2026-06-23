import type { Database } from "bun:sqlite";
import type { Guard } from "../guard";
import { ConnectorAuthManager } from "./auth";
import type { OAuthAttemptView, OAuthStartResult } from "./auth";
import { createBoundConnectorGuard, sourceForConnector } from "./guard";
import {
  InProcessRunnerSession,
  ProcessRunnerSession,
  type RunnerCapabilities,
  type RunnerSession,
} from "./process-runner";
import {
  activePlatformRequirements,
  currentConnectorPlatform,
  isPlatformSupported,
  validateConnectorId,
  validateConnectorManifest,
} from "./manifest";
import { WorkspaceConnectorRegistry, trustStatusForIntegration } from "./registry";
import { validateConnectorDefinition } from "./runtime";
import {
  ConnectorIntegrationStore,
  createConnectorStateHandle,
  defaultAuthRef,
  type EnsureIntegrationInput,
  type UpdateIntegrationInput,
} from "./state";
import { validateConnectorSchedule } from "./schedule";
import {
  isDirectOAuthAuthSpec,
  isOAuthAuthSpec,
  runtimeAuthType,
} from "./types";
import type {
  ConnectorConfigField,
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
  ConnectorWarningInput,
} from "./types";

export interface ConnectorRequirementView {
  id: string;
  status: ConnectorRequirementState | "unknown";
  message?: string;
  lastCheckedAt?: number;
}

export type ConnectorSetupPendingReason = "integration_key" | "auth" | "requirements";

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
  systemDb: Database;
  guard: Guard;
  host: ConnectorHostContext;
  platform?: ConnectorPlatform;
  authManager?: ConnectorAuthManager;
  officialCatalog?: ConnectorOfficialCatalogEntry[];
  // How long an aborted runner process gets to exit cooperatively before it
  // is force-killed.
  runnerKillGraceMs?: number;
  // How long bounded runner commands (load/check/request) may take before the
  // child is killed and the operation fails.
  runnerCommandTimeoutMs?: number;
  oauthRedirectUri?: string;
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
  private runnerKillGraceMs: number | undefined;
  private runnerCommandTimeoutMs: number | undefined;
  private guard: Guard;
  private host: ConnectorHostContext;
  private registry: WorkspaceConnectorRegistry;
  private oauthRedirectUri: string | undefined;

  constructor(opts: ConnectorSupervisorOptions) {
    this.guard = opts.guard;
    this.host = opts.host;
    this.store = new ConnectorIntegrationStore(opts.systemDb);
    this.authManager = opts.authManager ?? new ConnectorAuthManager();
    this.platform = opts.platform ?? currentConnectorPlatform();
    this.runnerKillGraceMs = opts.runnerKillGraceMs;
    this.runnerCommandTimeoutMs = opts.runnerCommandTimeoutMs;
    this.oauthRedirectUri = opts.oauthRedirectUri;
    this.registry = new WorkspaceConnectorRegistry({
      systemDb: opts.systemDb,
      officialCatalog: opts.officialCatalog ?? [],
    });
  }

  register<TConfig = unknown, TState = unknown>(
    manifest: ConnectorManifest,
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
    // D0 audit: the trust decision — who approved which exact package content.
    this.guard.writeEvent({
      type: "connector.approved",
      startedAt: Date.now(),
      payload: { connector_id: connectorId, approved_hash: approved.contentHash },
    });
    return approved.manifest;
  }

  // Drops the registration (package removed from the workspace) and aborts any
  // active runs. Integration rows are kept as non-runnable per the doc; their
  // trust flips to missing.
  async unregister(connectorId: string): Promise<boolean> {
    validateConnectorId(connectorId);
    const registration = this.registrations.get(connectorId);
    if (!registration) return false;
    this.registrations.delete(connectorId);

    for (const integration of this.store.list()) {
      if (integration.connectorId !== connectorId) continue;
      const active = this.activeRuns.get(integration.id);
      if (active) {
        active.abort();
        await active.promise.catch(() => {});
      }
    }
    this.store.setTrustForConnector(connectorId, "missing");
    this.guard.writeEvent({
      type: "connector.removed",
      startedAt: Date.now(),
      payload: { connector_id: connectorId },
    });
    return true;
  }

  // Removes one integration: aborts an active run, purges its credentials,
  // and deletes the row. Deleting the last integration of an installed
  // connector re-ensures a fresh first integration so the package keeps a
  // visible management entry.
  async removeIntegration(instanceId: string): Promise<void> {
    const integration = this.store.get(instanceId);
    if (!integration) {
      throw new Error(`Connector integration not found: ${instanceId}`);
    }
    const active = this.activeRuns.get(instanceId);
    if (active) {
      active.abort();
      await active.promise.catch(() => {});
    }
    if (integration.authRef) {
      await this.authManager.deleteToken(integration.authRef);
    }
    this.store.delete(instanceId);

    const registration = this.registrations.get(integration.connectorId);
    if (registration) {
      const remaining = this.store
        .list()
        .some((row) => row.connectorId === integration.connectorId);
      if (!remaining) {
        this.ensureFirstIntegration(integration.connectorId);
      }
    }
  }

  // apiKey connect: store the pasted token and run the normal connect flow.
  // oauth2 uses the browser authorization flow, not this token endpoint.
  async connectIntegrationWithToken<TConfig = unknown, TState = unknown>(
    instanceId: string,
    token: string,
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
    if (isOAuthAuthSpec(auth)) {
      throw new Error(`Connector ${existing.connectorId} uses oauth2; use the browser connect flow`);
    }
    if (!token || !token.trim()) {
      throw new Error("Connector apiKey connect requires a non-empty token");
    }
    const authRef = existing.authRef ?? defaultAuthRef(existing.id);
    await this.authManager.setToken(authRef, token.trim(), {
      ownerType: "connector",
      ownerId: existing.id,
    });
    return this.connectIntegration<TConfig, TState>(instanceId, { authRef });
  }

  startOAuthIntegration(
    instanceId: string,
    input: { redirectUri: string; clientSecret?: string; clientId?: string },
  ): OAuthStartResult {
    const existing = this.store.get(instanceId);
    if (!existing) {
      throw new Error(`Connector integration not found: ${instanceId}`);
    }
    const registration = this.requireRegistration(existing.connectorId);
    const auth = registration.manifest.auth ?? { type: "none" };
    if (!isOAuthAuthSpec(auth)) {
      throw new Error(`Connector ${existing.connectorId} does not use oauth2`);
    }
    if (!isPlatformSupported(registration.manifest, this.platform)) {
      throw new Error(`Connector ${existing.connectorId} is not supported on ${this.platform}`);
    }
    return this.authManager.startOAuth(existing, auth, input);
  }

  getOAuthAttempt(instanceId: string, attemptId: string): OAuthAttemptView {
    return this.authManager.getOAuthAttempt(instanceId, attemptId);
  }

  async completeOAuthCallback(params: URLSearchParams): Promise<OAuthAttemptView> {
    const result = await this.authManager.completeOAuthCallback(params);
    if (result.status === "connected" && result.integrationId && result.authRef) {
      const integration = this.store.get(result.integrationId);
      if (integration) {
        if (integration.authRef !== result.authRef) {
          this.store.update(integration.id, { authRef: result.authRef });
        }
        await this.refreshSetupStatus(integration.id);
      }
    }
    return result;
  }

  ensureIntegration<TConfig = unknown, TState = unknown>(
    input: EnsureIntegrationInput<TConfig>,
  ): ConnectorIntegration<TConfig, TState> {
    const registration = this.requireRegistration(input.connectorId);
    if (!isPlatformSupported(registration.manifest, this.platform)) {
      throw new Error(`Connector ${input.connectorId} is not supported on ${this.platform}`);
    }

    const mode = registration.manifest.integrations.mode;
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
    const mode = registration.manifest.integrations.mode;
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
      mode: registration.manifest.integrations.mode,
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

  isRegistered(connectorId: string): boolean {
    return this.registrations.has(connectorId);
  }

  ensureFirstIntegration(connectorId: string): ConnectorIntegration {
    const registration = this.requireRegistration(connectorId);
    const existing = this.store.firstForConnector(connectorId);
    if (existing) return existing;

    if (!isPlatformSupported(registration.manifest, this.platform)) {
      // Keep a visible, non-runnable row so the UI can show the connector as
      // unsupported on this device. supported=false blocks scheduling and runs.
      return this.store.ensure({
        connectorId,
        setupStatus: "setup",
        packageHash: registration.package?.contentHash,
        trustStatus: trustStatusForIntegration(registration.trust),
      });
    }
    return this.ensureIntegration({
      connectorId,
      setupStatus: firstIntegrationSetupStatus(
        registration.manifest,
        activePlatformRequirements(registration.manifest, this.platform).length > 0,
      ),
    });
  }

  async list(): Promise<Array<ConnectorIntegration & {
    name: string;
    mode: string;
    integrationsMode: "singleton" | "multiple";
    source: string | undefined;
    running: boolean;
    supported: boolean;
    packageTrust: ConnectorPackageTrust["status"];
    authType: string;
    authNeedsClientId?: boolean;
    authNeedsClientSecret?: boolean;
    authHostedDisabled?: boolean;
    authStatus?: string;
    authAttention?: "refresh_failed" | "redirect_uri_changed";
    authReady: boolean;
    setupPending: ConnectorSetupPendingReason[];
    requirements: ConnectorRequirementView[];
    configSchema?: Record<string, ConnectorConfigField>;
  }>> {
    return Promise.all(this.store.list().map(async (integration) => {
      const registration = this.registrations.get(integration.connectorId);
      const integrationsMode = registration?.manifest.integrations.mode ?? "singleton";
      const hasSourceIdentity = Boolean(
        integration.integrationKey || integrationsMode !== "multiple",
      );
      const activeRequirements = registration
        ? activePlatformRequirements(registration.manifest, this.platform)
        : [];
      const authSpec = registration?.manifest.auth ?? { type: "none" };
      const authType = authSpec.type;
      const authNeedsClientId = authSpec.type === "oauth2-byo-public"
        || authSpec.type === "oauth2-byo-confidential";
      const authNeedsClientSecret = authSpec.type === "oauth2-byo-confidential";
      const authHostedDisabled = authSpec.type === "oauth2-hosted";
      const credential = integration.authRef ? this.authManager.credential(integration.authRef) : undefined;
      const storedRedirectUri = typeof credential?.metadata?.redirect_uri === "string"
        ? credential.metadata.redirect_uri
        : undefined;
      const authAttention = credential?.status === "refresh_failed"
        ? "refresh_failed"
        : isDirectOAuthAuthSpec(authSpec)
          && storedRedirectUri
          && this.oauthRedirectUri
          && storedRedirectUri !== this.oauthRedirectUri
            ? "redirect_uri_changed"
            : undefined;
      const authReady = authType === "none"
        || Boolean(integration.authRef && (await this.authManager.hasToken(integration.authRef)));

      const setupPending: ConnectorSetupPendingReason[] = [];
      if (registration) {
        if (!hasSourceIdentity) setupPending.push("integration_key");
        if (!authReady) setupPending.push("auth");
        if (!this.requirementsSatisfiedFor(registration.manifest, integration)) {
          setupPending.push("requirements");
        }
      }

      return {
        ...integration,
        name: registration?.manifest.name ?? integration.connectorId,
        mode: registration?.manifest.runtime.mode ?? "unknown",
        integrationsMode,
        source: hasSourceIdentity
          ? sourceForConnector(integration.connectorId, integration.integrationKey)
          : undefined,
        running: this.activeRuns.has(integration.id),
        supported: registration ? isPlatformSupported(registration.manifest, this.platform) : false,
        packageTrust: registration?.trust.status ?? "missing",
        authType,
        authNeedsClientId,
        authNeedsClientSecret,
        authHostedDisabled,
        authStatus: credential?.status,
        authAttention,
        authReady,
        setupPending,
        requirements: activeRequirements.map((id) => ({
          id,
          status: integration.requirementsStatus?.[id]?.status ?? "unknown",
          message: integration.requirementsStatus?.[id]?.message,
          lastCheckedAt: integration.requirementsStatus?.[id]?.lastCheckedAt,
        })),
        configSchema: registration?.manifest.config,
      };
    }));
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

  // Re-runs the unified setup evaluator for one integration. Use after edits
  // that can complete setup without an auth/requirement action (for example
  // setting the integration key on a no-auth connector).
  async refreshIntegrationSetup<TConfig = unknown, TState = unknown>(
    instanceId: string,
  ): Promise<ConnectorIntegration<TConfig, TState>> {
    return (await this.refreshSetupStatus(instanceId)) as ConnectorIntegration<TConfig, TState>;
  }

  // Explicit human recovery for a crashed run. Crashed ready integrations stay
  // in error ("needs attention") by design — a connector bug should be seen,
  // not silently retried. Restart resets to idle so the scheduler picks the
  // integration up again.
  restartIntegration<TConfig = unknown, TState = unknown>(
    instanceId: string,
  ): ConnectorIntegration<TConfig, TState> {
    const integration = this.store.get<TConfig, TState>(instanceId);
    if (!integration) {
      throw new Error(`Connector integration not found: ${instanceId}`);
    }
    this.requireRegistration(integration.connectorId);
    if (this.activeRuns.has(instanceId) || integration.status === "running") {
      throw new Error(`Connector integration is already running: ${instanceId}`);
    }
    if (!integration.enabled || integration.status === "disabled") {
      throw new Error(`Connector integration is disabled: ${instanceId}`);
    }
    if (integration.setupStatus !== "ready" || integration.status === "setup") {
      throw new Error(`Connector integration is not set up: ${instanceId}`);
    }
    if (integration.status !== "error") {
      return integration;
    }
    this.store.resetErrorToIdle(instanceId);
    return this.store.get<TConfig, TState>(instanceId)!;
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

    // Trust before handler: loading requirement handlers runs connector code,
    // so the package must pass the same trust gate as run(). Package handlers
    // execute in a separate runner process.
    const session = await this.openTrustedSession(registration);
    try {
      const records = await this.evaluateRequirements(registration, integration, session, requirementIds);
      await this.refreshSetupStatus(instanceId);
      return records;
    } finally {
      await session.close();
    }
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

    const session = await this.openTrustedSession(registration);
    try {
      if (!session.requirementIds().includes(requirementId)) {
        throw new Error(
          `Connector ${integration.connectorId} does not implement requirement handler: ${requirementId}`,
        );
      }

      const ctx = this.requirementContext(integration);
      const rawRequest = await session.request(requirementId, ctx);
      const requestStatus = rawRequest === null ? undefined : normalizeRequirementStatus(rawRequest);
      if (requestStatus?.status === "error") {
        const record: ConnectorRequirementRecord = {
          ...requestStatus,
          lastCheckedAt: Date.now(),
        };
        this.persistRequirementRecords(instanceId, { [requirementId]: record });
        await this.refreshSetupStatus(instanceId);
        return record;
      }

      const records = await this.evaluateRequirements(registration, integration, session, [requirementId]);
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
    } finally {
      await session.close();
    }
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
    session: RunnerSession,
    requirementIds: string[],
  ): Promise<Record<string, ConnectorRequirementRecord>> {
    const ctx = this.requirementContext(integration);
    const results = await session.check(requirementIds, ctx);
    const updates: Record<string, ConnectorRequirementRecord> = {};
    for (const id of requirementIds) {
      const result = results[id] ?? null;
      const status: ConnectorRequirementStatus = result === null
        ? {
          status: "error",
          message: `Connector ${registration.manifest.id} does not implement requirement handler: ${id}`,
        }
        : normalizeRequirementStatus(result);
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
    const mode = manifest.integrations.mode;
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

  // Auth gets the same run-time recheck as requirements: a token deleted or
  // invalidated after ready must block the run up front, not fail lazily
  // inside connector code. Checked before the trust import since it needs no
  // connector code.
  private async assertRunAuth(
    registration: Registration,
    integration: ConnectorIntegration,
  ): Promise<void> {
    const auth = registration.manifest.auth ?? { type: "none" };
    if (auth.type === "none") return;
    if (integration.authRef && (await this.authManager.hasToken(integration.authRef))) return;
    this.store.update(integration.id, { setupStatus: "setup" });
    throw new Error(
      `Connector ${integration.connectorId} credentials are missing; reconnect the integration`,
    );
  }

  private async assertRunRequirements(
    registration: Registration,
    integration: ConnectorIntegration,
    session: RunnerSession,
  ): Promise<void> {
    const requirementIds = activePlatformRequirements(registration.manifest, this.platform);
    if (requirementIds.length === 0) return;

    const records = await this.evaluateRequirements(registration, integration, session, requirementIds);
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
    const mode = registration.manifest.integrations.mode;
    if (mode === "multiple" && !integration.integrationKey) {
      throw new Error(`Connector integration requires an integration_key: ${instanceId}`);
    }
    if (!isPlatformSupported(registration.manifest, this.platform)) {
      throw new Error(`Connector ${integration.connectorId} is not supported on ${this.platform}`);
    }

    const controller = new AbortController();
    this.store.setStatus(instanceId, "running");

    const promise = (async () => {
      let session: RunnerSession | undefined;
      try {
        await this.assertRunAuth(registration, integration);
        // The abort signal is bound from the very first phase: an abort during
        // a hanging top-level import or requirement check kills the child.
        session = await this.openTrustedSession(registration, controller.signal);
        await this.assertRunRequirements(registration, integration, session);
        await session.run({
          config: mergeConfig(schemaDefaults(registration.manifest), integration.config, opts?.config),
          host: this.host,
          signal: controller.signal,
          capabilities: this.buildRunCapabilities(registration, integration),
        });
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
        await session?.close().catch(() => {});
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

  // Opens a runner session for trusted connector code. Workspace packages are
  // re-verified (hash/trust) and then executed in a separate runner process;
  // manually registered definitions run in-process. Trust always passes before
  // any connector code is loaded anywhere.
  private async openTrustedSession(
    registration: Registration,
    abortSignal?: AbortSignal,
  ): Promise<RunnerSession> {
    if (!registration.package) {
      if (registration.definition) return new InProcessRunnerSession(registration.definition);
      throw new Error(`Connector ${registration.manifest.id} has no package entry`);
    }

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

    const session = new ProcessRunnerSession({
      entryPath: current.entryPath,
      contentHash: current.contentHash,
      cwd: current.dir,
      killGraceMs: this.runnerKillGraceMs,
      commandTimeoutMs: this.runnerCommandTimeoutMs,
    });
    await session.open(abortSignal);
    return session;
  }

  private buildRunCapabilities(
    registration: Registration,
    integration: ConnectorIntegration,
  ): RunnerCapabilities {
    const boundGuard = createBoundConnectorGuard(
      this.guard,
      integration.connectorId,
      integration.integrationKey,
    );
    const stateHandle = createConnectorStateHandle(this.store, integration.id);
    const authSpec = registration.manifest.auth ?? { type: "none" };
    const authHandle = this.authManager.createHandle(authSpec, integration);
    return {
      authType: runtimeAuthType(authSpec),
      writeEvent: (event) => boundGuard.writeEvent(event as Parameters<typeof boundGuard.writeEvent>[0]),
      writeEvents: (events) => boundGuard.writeEvents(events as Parameters<typeof boundGuard.writeEvents>[0]),
      stateGet: () => stateHandle.get(),
      stateSet: (value) => stateHandle.set(value),
      authGetToken: () => authHandle.type === "none"
        ? Promise.reject(new Error("Connector does not use auth"))
        : authHandle.getToken(),
      warningSet: async (value) => {
        this.store.setWarning(integration.id, value as ConnectorWarningInput);
      },
      warningClear: async (key) => {
        if (typeof key !== "string") throw new Error("Connector warning key must be a string");
        this.store.clearWarning(integration.id, key);
      },
    };
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

// Author defaults declared in the manifest config schema. They form the base
// layer of the run-time config merge (schema defaults -> integration overrides
// -> one-off run override), so connector code reads merged values directly.
function schemaDefaults(manifest: ConnectorManifest): Record<string, unknown> | undefined {
  const schema = manifest.config;
  if (!schema) return undefined;
  const defaults: Record<string, unknown> = {};
  for (const [key, field] of Object.entries(schema)) {
    if (field.default !== undefined) defaults[key] = field.default;
  }
  return Object.keys(defaults).length > 0 ? defaults : undefined;
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
  if (manifest.integrations.mode === "multiple") return "setup";
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
