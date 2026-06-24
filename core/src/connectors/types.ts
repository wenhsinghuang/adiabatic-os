import type { JsonValue } from "../json";

export type MaybePromise<T> = T | Promise<T>;
export type { JsonValue };
export type JsonObject = { [key: string]: JsonValue };

export type ConnectorRuntimeMode = "watch" | "poll" | "manual";
export type ConnectorPlatform =
  | "darwin"
  | "linux"
  | "windows"
  | "ios"
  | "android"
  | "cloud";

export type ConnectorOAuthPublicAuthSpec = {
  type: "oauth2-public";
  authorizationEndpoint: string;
  tokenEndpoint: string;
  clientId: string;
  scope?: string[];
};

export type ConnectorOAuthHostedAuthSpec = {
  type: "oauth2-hosted";
  connectEndpoint: string;
  scope?: string[];
};

export type ConnectorOAuthDirectAuthSpec = ConnectorOAuthPublicAuthSpec;

export type ConnectorOAuthAuthSpec =
  | ConnectorOAuthDirectAuthSpec
  | ConnectorOAuthHostedAuthSpec;

export type ConnectorRuntimeAuthType = "none" | "apiKey" | "oauth2";

export type ConnectorAuthSpec =
  | { type: "none" }
  | { type: "apiKey"; label?: string }
  | ConnectorOAuthAuthSpec;

export function isOAuthAuthSpec(auth: ConnectorAuthSpec): auth is ConnectorOAuthAuthSpec {
  return auth.type === "oauth2-public"
    || auth.type === "oauth2-hosted";
}

export function isDirectOAuthAuthSpec(auth: ConnectorAuthSpec): auth is ConnectorOAuthDirectAuthSpec {
  return auth.type === "oauth2-public";
}

export function isHostedOAuthAuthSpec(auth: ConnectorAuthSpec): auth is ConnectorOAuthHostedAuthSpec {
  return auth.type === "oauth2-hosted";
}

export function isDirectOAuthAuthType(type: string): boolean {
  return type === "oauth2-public";
}

export function runtimeAuthType(auth: ConnectorAuthSpec): ConnectorRuntimeAuthType {
  if (auth.type === "none" || auth.type === "apiKey") return auth.type;
  return "oauth2";
}

export interface ConnectorRuntimeSpec {
  mode: ConnectorRuntimeMode;
  defaultSchedule?: string;
}

export type ConnectorIntegrationMode = "singleton" | "multiple";

export interface ConnectorIntegrationsSpec {
  mode: ConnectorIntegrationMode;
}

export interface ConnectorPlatformSpec {
  requirements?: string[];
}

export type ConnectorPlatformsSpec = Partial<Record<ConnectorPlatform, ConnectorPlatformSpec>>;

export type ConnectorConfigFieldType = "string" | "number" | "boolean";

// One user-facing config field, keyed by name in ConnectorManifest.config.
// `default` is the author default (shown to the user, applied by the host).
export interface ConnectorConfigField {
  type: ConnectorConfigFieldType;
  label: string;
  default?: JsonValue;
}

export interface ConnectorManifest {
  id: string;
  name: string;
  entry: string;
  runtime: ConnectorRuntimeSpec;
  // Required: source identity cardinality is an explicit author decision.
  // The parser rejects manifests that omit it; there is no singleton default.
  integrations: ConnectorIntegrationsSpec;
  platforms?: ConnectorPlatformsSpec;
  capabilities?: string[];
  auth?: ConnectorAuthSpec;
  // Config schema: user-facing fields (type/label/default). Author defaults live
  // here (shown to the user, applied by the host); user-chosen values are
  // overrides in integration config. Internal constants stay in code, undeclared.
  config?: Record<string, ConnectorConfigField>;
}

export interface ConnectorEventInput {
  type: string;
  externalId: string;
  startedAt: number;
  endedAt?: number;
  payload: JsonValue;
}

export interface BoundConnectorGuard {
  writeEvent(event: ConnectorEventInput): Promise<{ id: string }>;
  writeEvents(events: ConnectorEventInput[]): Promise<{ ids: string[] }>;
}

export type ConnectorAuthHandle =
  | { type: "none" }
  | {
      type: "apiKey" | "oauth2";
      getToken(): Promise<string>;
    };

export interface ConnectorStateHandle<TState = unknown> {
  get(): Promise<TState | undefined>;
  set(state: TState): Promise<void>;
}

export interface ConnectorWarningInput {
  key: string;
  message: string;
  details?: JsonValue;
}

export interface ConnectorWarningRecord extends ConnectorWarningInput {
  firstSeenAt: number;
  lastSeenAt: number;
}

export interface ConnectorWarningsHandle {
  set(warning: ConnectorWarningInput): Promise<void>;
  clear(key: string): Promise<void>;
}

export interface ConnectorHostContext {
  workspacePath: string;
}

export interface ConnectorRunContext<TConfig = unknown, TState = unknown> {
  guard: BoundConnectorGuard;
  auth: ConnectorAuthHandle;
  state: ConnectorStateHandle<TState>;
  warnings: ConnectorWarningsHandle;
  config: TConfig;
  host: ConnectorHostContext;
  signal: AbortSignal;
}

export type ConnectorRequirementState = "satisfied" | "missing" | "pending" | "error";

export interface ConnectorRequirementStatus {
  status: ConnectorRequirementState;
  message?: string;
}

export interface ConnectorRequirementRecord extends ConnectorRequirementStatus {
  lastCheckedAt: number;
}

export interface ConnectorRequirementContext {
  connectorId: string;
  integrationId: string;
  integrationKey: string | undefined;
  platform: ConnectorPlatform;
  host: ConnectorHostContext;
}

export interface ConnectorRequirementHandler {
  label: string;
  description?: string;
  check(ctx: ConnectorRequirementContext): MaybePromise<ConnectorRequirementStatus>;
  request?(ctx: ConnectorRequirementContext): MaybePromise<ConnectorRequirementStatus>;
}

export interface ConnectorDefinition<TConfig = unknown, TState = unknown> {
  run(context: ConnectorRunContext<TConfig, TState>): MaybePromise<void>;
  requirements?: Record<string, ConnectorRequirementHandler>;
}

export interface ConnectorIntegration<TConfig = unknown, TState = unknown> {
  id: string;
  connectorId: string;
  integrationKey: string | undefined;
  enabled: boolean;
  status: ConnectorIntegrationStatus;
  setupStatus: ConnectorSetupStatus;
  trustStatus: ConnectorTrustStatus;
  scheduleCron: string | undefined;
  nextRunAt: number | undefined;
  packageHash: string | undefined;
  config: TConfig | undefined;
  syncState: TState | undefined;
  requirementsStatus: Record<string, ConnectorRequirementRecord> | undefined;
  authRef: string | undefined;
  lastError: string | undefined;
  warnings: ConnectorWarningRecord[] | undefined;
  lastRunAt: number | undefined;
  createdAt: number;
  updatedAt: number;
}

export type ConnectorIntegrationStatus = "setup" | "idle" | "running" | "error" | "disabled";
export type ConnectorSetupStatus = "setup" | "ready";
export type ConnectorTrustStatus = "official" | "custom" | "modified" | "untrusted" | "missing";

export type ConnectorPackageTrustStatus = ConnectorTrustStatus | "invalid";

export interface ConnectorPackageTrust {
  status: ConnectorPackageTrustStatus;
  runnable: boolean;
  badge: "Official" | "Custom" | "Modified" | "Untrusted" | "Missing" | "Invalid";
  reason?: string;
}

export interface ConnectorOfficialCatalogEntry {
  id: string;
  hash: string;
  version?: string;
}

export interface ConnectorPackageRecord {
  connectorId: string;
  dir: string;
  manifest: ConnectorManifest;
  entryPath: string;
  contentHash: string;
  trust: ConnectorPackageTrust;
}

export interface ConnectorRunHandle {
  instanceId: string;
  signal: AbortSignal;
  promise: Promise<void>;
  abort(): void;
}

export function defineConnector<TConfig = unknown, TState = unknown>(
  definition: ConnectorDefinition<TConfig, TState>,
): ConnectorDefinition<TConfig, TState> {
  return definition;
}
