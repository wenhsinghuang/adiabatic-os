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
