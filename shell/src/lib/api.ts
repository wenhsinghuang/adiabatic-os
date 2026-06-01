// HTTP client for core runtime (localhost:3000)

const BASE = "http://localhost:3000";

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
  const res = await fetch(`${BASE}${path}`, {
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
      const res = await fetch(`${BASE}/api/docs/events`, {
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
