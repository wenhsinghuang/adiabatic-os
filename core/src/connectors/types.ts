import type { JsonValue } from "../json";

export type MaybePromise<T> = T | Promise<T>;
export type { JsonValue };
export type JsonObject = { [key: string]: JsonValue };

export type ConnectorRuntimeMode = "watch" | "poll" | "import";
export type ConnectorPlatform =
  | "darwin"
  | "linux"
  | "windows"
  | "ios"
  | "android"
  | "cloud";

export type ConnectorAuthSpec =
  | { type: "none" }
  | { type: "apiKey"; label?: string }
  | { type: "oauth2"; provider: string; scopes?: string[] };

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

export interface ConnectorManifest<TConfig = JsonObject> {
  id: string;
  name: string;
  entry: string;
  runtime: ConnectorRuntimeSpec;
  integrations?: ConnectorIntegrationsSpec;
  platforms?: ConnectorPlatformsSpec;
  capabilities?: string[];
  auth?: ConnectorAuthSpec;
  config?: TConfig;
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

export interface ConnectorHostContext {
  workspacePath: string;
}

export interface ConnectorRunContext<TConfig = unknown, TState = unknown> {
  guard: BoundConnectorGuard;
  auth: ConnectorAuthHandle;
  state: ConnectorStateHandle<TState>;
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
