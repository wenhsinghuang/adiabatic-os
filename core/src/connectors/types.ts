import type { EventInput } from "../guard";
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
  | { type: "oauth2"; provider: string; scopes?: string[] }
  | { type: "localPermission"; permission?: string };

export interface ConnectorRuntimeSpec {
  mode: ConnectorRuntimeMode;
  schedule?: string;
}

export interface ConnectorManifest<TConfig = JsonObject> {
  id: string;
  name: string;
  entry: string;
  runtime: ConnectorRuntimeSpec;
  platforms?: ConnectorPlatform[];
  capabilities?: string[];
  auth?: ConnectorAuthSpec;
  events?: string[];
  config?: TConfig;
}

export type ConnectorEventInput = Omit<EventInput, "schemaVersion">;

export interface BoundConnectorGuard {
  writeEvent(event: ConnectorEventInput): Promise<{ id: string }>;
  writeEvents(events: ConnectorEventInput[]): Promise<{ ids: string[] }>;
}

export type ConnectorAuthHandle =
  | { type: "none" }
  | {
      type: "apiKey" | "oauth2" | "localPermission";
      getToken(): Promise<string>;
    };

export interface ConnectorStateHandle<TState = unknown> {
  get(): Promise<TState | undefined>;
  set(state: TState): Promise<void>;
}

export interface ConnectorRunContext<TConfig = unknown, TState = unknown> {
  guard: BoundConnectorGuard;
  auth: ConnectorAuthHandle;
  state: ConnectorStateHandle<TState>;
  config: TConfig;
  signal: AbortSignal;
}

export interface ConnectorDefinition<TConfig = unknown, TState = unknown> {
  run(context: ConnectorRunContext<TConfig, TState>): MaybePromise<void>;
}

export interface ConnectorIntegration<TConfig = unknown, TState = unknown> {
  id: string;
  connectorId: string;
  enabled: boolean;
  status: ConnectorIntegrationStatus;
  config: TConfig | undefined;
  syncState: TState | undefined;
  authRef: string | undefined;
  lastError: string | undefined;
  lastRunAt: number | undefined;
  createdAt: number;
  updatedAt: number;
}

export type ConnectorIntegrationStatus = "idle" | "running" | "error" | "disabled";

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
