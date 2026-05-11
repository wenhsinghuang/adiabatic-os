// HTTP client for core runtime (localhost:3000)

const BASE = "http://localhost:3000";

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    headers: { "Content-Type": "application/json" },
    ...options,
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data as T;
}

// -- Docs --

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
