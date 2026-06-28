// HTTP client for core runtime. Electron provides the production URL; browser
// dev keeps a default so `npm run dev` can still talk to a standalone core.

let cachedCoreBaseUrl: string | null = null;

export async function getCoreBaseUrl(): Promise<string> {
  if (cachedCoreBaseUrl) return cachedCoreBaseUrl;
  const hostBase = await window.adiabaticHost?.getCoreBaseUrl().catch(() => null);
  const resolved = hostBase
    ?? import.meta.env.VITE_ADIABATIC_CORE_URL
    ?? "http://localhost:3000";
  cachedCoreBaseUrl = resolved;
  return resolved;
}

export function clearCoreBaseUrlCache(): void {
  cachedCoreBaseUrl = null;
}

export async function getCoreToken(): Promise<string> {
  const token = await window.adiabaticHost?.getCoreToken();
  if (!token) {
    throw new Error("Core API requires the Electron host security token.");
  }
  return token;
}

export async function getBridgeToken(): Promise<string> {
  const token = await window.adiabaticHost?.getBridgeToken();
  if (!token) {
    throw new Error("App bridge requires the Electron host security token.");
  }
  return token;
}

async function coreHeaders(options?: RequestInit): Promise<Headers> {
  const headers = new Headers(options?.headers);
  headers.set("Authorization", `Bearer ${await getCoreToken()}`);
  if (!headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }
  return headers;
}

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const base = await getCoreBaseUrl();
  const res = await fetch(`${base}${path}`, {
    ...options,
    headers: await coreHeaders(options),
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : {};
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data as T;
}

export function subscribeDocEvents(
  onEvent: (event: { id: string }) => void,
  onError?: (error: unknown) => void,
): () => void {
  const controller = new AbortController();

  void (async () => {
    try {
      const base = await getCoreBaseUrl();
      const res = await fetch(`${base}/api/docs/events`, {
        headers: await coreHeaders(),
        signal: controller.signal,
      });
      if (!res.ok) {
        const text = await res.text();
        const data = text ? JSON.parse(text) : {};
        throw new Error(data.error || `HTTP ${res.status}`);
      }
      if (!res.body) throw new Error("Doc event stream is unavailable");

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        let boundary = buffer.indexOf("\n\n");
        while (boundary !== -1) {
          const rawEvent = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          const data = rawEvent
            .split("\n")
            .filter((line) => line.startsWith("data:"))
            .map((line) => line.slice("data:".length).trim())
            .join("\n");
          if (data) onEvent(JSON.parse(data) as { id: string });
          boundary = buffer.indexOf("\n\n");
        }
      }
    } catch (err) {
      if (!controller.signal.aborted) onError?.(err);
    }
  })();

  return () => controller.abort();
}

// -- Docs --

export interface WorkspaceInfo {
  path: string;
}

export function getWorkspace(): Promise<WorkspaceInfo> {
  return request("/api/workspace");
}

// -- Lamarck identity --

export interface LamarckSessionView {
  status: "signed_out" | "signed_in" | "expired";
  userId?: string;
  sessionId?: string;
  accessTokenExpiresAt?: string;
  refreshTokenExpiresAt?: string;
  apiOrigin?: string;
  appOrigin?: string;
}

export interface LamarckLoginStart {
  authorizationUrl: string;
  attemptId: string;
  redirectUri: string;
  expiresAt: number;
}

export function getLamarckSession(): Promise<LamarckSessionView> {
  return request("/api/identity/session");
}

export function startLamarckLogin(): Promise<LamarckLoginStart> {
  return request("/api/identity/login/start", {
    method: "POST",
    body: JSON.stringify({}),
  });
}

export function logoutLamarckSession(): Promise<{ ok: true }> {
  return request("/api/identity/logout", {
    method: "POST",
    body: JSON.stringify({}),
  });
}

export interface Doc {
  id: string;
  content: string;
  metadata: Record<string, unknown> | null;
  created_at: number;
  updated_at: number;
}

export function getDoc(id: string): Promise<Doc> {
  return request(`/api/docs/${encodeURIComponent(id)}`);
}

export function saveDoc(
  id: string,
  content: string,
  metadata?: Record<string, unknown>,
): Promise<{ ok: true; id: string }> {
  return request("/api/docs", {
    method: "POST",
    body: JSON.stringify({ id, content, metadata }),
  });
}

export function deleteDoc(id: string): Promise<{ ok: true }> {
  return request(`/api/docs/${encodeURIComponent(id)}`, { method: "DELETE" });
}

export function listDocs(): Promise<{ rows: Doc[] }> {
  return request("/api/query", {
    method: "POST",
    body: JSON.stringify({
      sql: "SELECT id, metadata, created_at, updated_at FROM docs ORDER BY updated_at DESC",
    }),
  });
}

// -- Apps --

export interface AppInfo {
  id: string;
  name: string;
  permissions: { write: string[] };
  components: string[];
  entryPoint: string;
}

export function listApps(): Promise<{ apps: AppInfo[] }> {
  return request("/api/apps");
}

export function getAppSource(appId: string): Promise<Record<string, string>> {
  return request(`/api/apps/${encodeURIComponent(appId)}/source`);
}

export function createApp(id: string, name: string): Promise<{ ok: true; id: string }> {
  return request("/api/apps", {
    method: "POST",
    body: JSON.stringify({ id, name }),
  });
}

export function archiveApp(appId: string): Promise<{ ok: true; id: string }> {
  return request(`/api/apps/${encodeURIComponent(appId)}/archive`, {
    method: "POST",
  });
}

export function saveAppFile(
  appId: string,
  filename: string,
  content: string,
): Promise<{ ok: true }> {
  return request(`/api/apps/${encodeURIComponent(appId)}/files/${encodeURIComponent(filename)}`, {
    method: "PUT",
    body: JSON.stringify({ content }),
  });
}

// -- Query / Write (system bridge for components) --

export function query(sql: string, params?: unknown[]): Promise<{ rows: unknown[] }> {
  return request("/api/query", {
    method: "POST",
    body: JSON.stringify({ sql, params }),
  });
}

export function write(sql: string, params?: unknown[]): Promise<{ ok: true }> {
  return request("/api/write", {
    method: "POST",
    body: JSON.stringify({ sql, params }),
  });
}

// -- Connectors --

export type ConnectorTrust =
  | "official"
  | "custom"
  | "modified"
  | "untrusted"
  | "missing"
  | "invalid";

export type ConnectorRequirementState =
  | "satisfied"
  | "missing"
  | "pending"
  | "error"
  | "unknown";

export type ConnectorAuthType =
  | "none"
  | "apiKey"
  | "oauth2-public"
  | "managedProvider";

export interface ConnectorRequirementView {
  id: string;
  status: ConnectorRequirementState;
  message?: string;
  lastCheckedAt?: number;
}

export interface ConnectorWarningRecord {
  key: string;
  message: string;
  details?: unknown;
  firstSeenAt: number;
  lastSeenAt: number;
}

export type ConnectorSetupPendingReason = "integration_key" | "auth" | "requirements";

export interface ConnectorConfigFieldView {
  type: "string" | "number" | "boolean";
  label: string;
  default?: string | number | boolean;
}

export interface ConnectorIntegrationView {
  id: string;
  connectorId: string;
  integrationKey?: string;
  name: string;
  mode: "watch" | "poll" | "manual" | "unknown";
  integrationsMode: "singleton" | "multiple";
  enabled: boolean;
  status: "setup" | "idle" | "running" | "error" | "disabled";
  setupStatus: "setup" | "ready";
  packageTrust: ConnectorTrust;
  authType: ConnectorAuthType;
  authStatus?: string;
  authAttention?: "refresh_failed" | "redirect_uri_changed";
  authReady: boolean;
  oauthRedirectUri?: string;
  setupPending: ConnectorSetupPendingReason[];
  source?: string;
  running: boolean;
  supported: boolean;
  scheduleCron?: string;
  nextRunAt?: number;
  packageHash?: string;
  requirements: ConnectorRequirementView[];
  lastError?: string;
  warnings?: ConnectorWarningRecord[];
  lastRunAt?: number;
  // Config schema declared by the connector manifest (user-facing fields).
  configSchema?: Record<string, ConnectorConfigFieldView>;
  // Current user override values stored on the integration.
  config?: Record<string, string | number | boolean>;
}

export function listConnectors(): Promise<{ connectors: ConnectorIntegrationView[] }> {
  return request("/api/connectors");
}

// Bundled catalog entries. Installing one is an explicit action through the
// same flow as any other connector package; installed mirrors whether the
// package is currently registered in the workspace.
export interface AvailableConnectorView {
  connectorId: string;
  name: string;
  mode: "watch" | "poll" | "manual";
  integrationsMode: "singleton" | "multiple";
  authType: ConnectorAuthType;
  supported: boolean;
  installed: boolean;
}

export function listAvailableConnectors(): Promise<{ available: AvailableConnectorView[] }> {
  return request("/api/connectors/available");
}

export function installConnector(connectorId: string): Promise<{ ok: true }> {
  return request(`/api/connectors/${encodeURIComponent(connectorId)}/install`, {
    method: "POST",
    body: JSON.stringify({}),
  });
}

export function approveConnector(connectorId: string): Promise<{ ok: true }> {
  return request(`/api/connectors/${encodeURIComponent(connectorId)}/approve`, {
    method: "POST",
    body: JSON.stringify({}),
  });
}

export function checkConnectorRequirements(
  integrationId: string,
): Promise<{ requirements: Record<string, ConnectorRequirementView> }> {
  return request(
    `/api/connectors/integrations/${encodeURIComponent(integrationId)}/requirements/check`,
    { method: "POST", body: JSON.stringify({}) },
  );
}

export function requestConnectorRequirement(
  integrationId: string,
  requirementId: string,
): Promise<{ requirement: ConnectorRequirementView }> {
  return request(
    `/api/connectors/integrations/${encodeURIComponent(integrationId)}/requirements/${encodeURIComponent(requirementId)}/request`,
    { method: "POST", body: JSON.stringify({}) },
  );
}

export function restartConnectorIntegration(
  integrationId: string,
): Promise<{ integration: ConnectorIntegrationRow }> {
  return request(
    `/api/connectors/integrations/${encodeURIComponent(integrationId)}/restart`,
    { method: "POST", body: JSON.stringify({}) },
  );
}

// Trigger a one-off run on demand (manual connectors; or any connector's
// explicit run). Optional config rides as a one-off run override.
export function runConnectorIntegration(
  integrationId: string,
  config?: Record<string, unknown>,
): Promise<{ ok: true }> {
  return request(
    `/api/connectors/integrations/${encodeURIComponent(integrationId)}/run`,
    { method: "POST", body: JSON.stringify(config !== undefined ? { config } : {}) },
  );
}

// Mutation endpoints return the raw integration row (no name/setupPending/
// requirements enrichment — those only come from listConnectors). Callers
// should refresh the list after a mutation instead of consuming this shape.
export interface ConnectorIntegrationRow {
  id: string;
  connectorId: string;
  integrationKey?: string;
  enabled: boolean;
  status: "setup" | "idle" | "running" | "error" | "disabled";
  setupStatus: "setup" | "ready";
  scheduleCron?: string;
  nextRunAt?: number;
  lastError?: string;
  warnings?: ConnectorWarningRecord[];
  lastRunAt?: number;
}

export function updateConnectorIntegration(
  integrationId: string,
  input: { enabled?: boolean; scheduleCron?: string | null; integrationKey?: string; config?: Record<string, unknown> },
): Promise<{ integration: ConnectorIntegrationRow }> {
  return request(`/api/connectors/integrations/${encodeURIComponent(integrationId)}`, {
    method: "PATCH",
    body: JSON.stringify(input),
  });
}

export function createConnectorIntegration(
  connectorId: string,
  integrationKey: string,
): Promise<{ integration: ConnectorIntegrationRow }> {
  return request(`/api/connectors/${encodeURIComponent(connectorId)}/integrations`, {
    method: "POST",
    body: JSON.stringify({ integrationKey }),
  });
}

export function deleteConnectorIntegration(integrationId: string): Promise<{ ok: true }> {
  return request(`/api/connectors/integrations/${encodeURIComponent(integrationId)}`, {
    method: "DELETE",
  });
}

export function connectConnectorIntegration(
  integrationId: string,
  token: string,
): Promise<{ integration: ConnectorIntegrationRow }> {
  return request(`/api/connectors/integrations/${encodeURIComponent(integrationId)}/connect`, {
    method: "POST",
    body: JSON.stringify({ token }),
  });
}

export interface OAuthStartResult {
  authorizationUrl: string;
  attemptId: string;
  redirectUri?: string;
  expiresAt: number;
}

export type OAuthAttemptStatus = "pending" | "connected" | "failed" | "expired";

export interface OAuthAttemptResult {
  status: OAuthAttemptStatus;
  credentialId?: string;
  error?: string;
}

export function startConnectorAuth(integrationId: string): Promise<OAuthStartResult> {
  return request(`/api/connectors/integrations/${encodeURIComponent(integrationId)}/auth/start`, {
    method: "POST",
  });
}

export function getConnectorAuthAttempt(
  integrationId: string,
  attemptId: string,
): Promise<OAuthAttemptResult> {
  return request(
    `/api/connectors/integrations/${encodeURIComponent(integrationId)}/auth/attempts/${encodeURIComponent(attemptId)}`,
  );
}

export function removeConnector(connectorId: string): Promise<{ ok: true; removed: boolean }> {
  return request(`/api/connectors/${encodeURIComponent(connectorId)}`, {
    method: "DELETE",
  });
}

// -- Schema lifecycle approval --

export interface SchemaRequest {
  id: string;
  kind: "promote" | "demote";
  ddl: string[];
  requestedBy: string;
  createdAt: number;
  beforeSchema: unknown;
  status: "pending" | "applied" | "rejected" | "failed";
  error?: string;
}

export function listSchemaRequests(): Promise<{ requests: SchemaRequest[] }> {
  return request("/api/schema/requests");
}

export function approveSchemaRequest(
  id: string,
  remember = false,
): Promise<{ request: SchemaRequest }> {
  return request(`/api/schema/requests/${encodeURIComponent(id)}/approve`, {
    method: "POST",
    body: JSON.stringify({ remember }),
  });
}

export function rejectSchemaRequest(id: string): Promise<{ request: SchemaRequest }> {
  return request(`/api/schema/requests/${encodeURIComponent(id)}/reject`, {
    method: "POST",
    body: JSON.stringify({}),
  });
}
