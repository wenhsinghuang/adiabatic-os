// System bridge — provides the system.* API to app components.
// All calls route through the WebContainer's bridge-server, not directly to core.
// This ensures sandbox-level isolation: the bridge-server enforces app identity.

import { getServerUrl } from "./webcontainer";

export interface System {
  query(sql: string, params?: unknown[]): Promise<unknown[]>;
  write(sql: string, params?: unknown[]): Promise<void>;
  writeDoc(id: string, content: string, metadata?: Record<string, unknown>): Promise<void>;
  deleteDoc(id: string): Promise<void>;
  writeEvent(event: {
    source: string;
    type: string;
    startedAt: number;
    endedAt?: number;
    externalId?: string;
    payload: Record<string, unknown>;
  }): Promise<string>;
}

async function bridgeCall(
  appId: string,
  method: string,
  body: unknown,
): Promise<unknown> {
  const baseUrl = getServerUrl();
  if (!baseUrl) throw new Error("Sandbox bridge not ready");

  const res = await fetch(`${baseUrl}/system/${method}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-App-Id": appId,
    },
    body: JSON.stringify(body),
  });

  const data = await res.json();
  if (!res.ok) throw new Error(data.error || `Bridge call failed: ${res.status}`);
  return data;
}

export function createSystemBridge(appId: string): System {
  return {
    async query(sql: string, params?: unknown[]): Promise<unknown[]> {
      const result = (await bridgeCall(appId, "query", { sql, params })) as { rows: unknown[] };
      return result.rows;
    },

    async write(sql: string, params?: unknown[]): Promise<void> {
      await bridgeCall(appId, "write", { sql, params });
    },

    async writeDoc(
      id: string,
      content: string,
      metadata?: Record<string, unknown>,
    ): Promise<void> {
      await bridgeCall(appId, "writeDoc", { id, content, metadata });
    },

    async deleteDoc(id: string): Promise<void> {
      await bridgeCall(appId, "deleteDoc", { id });
    },

    async writeEvent(event: {
      source: string;
      type: string;
      startedAt: number;
      endedAt?: number;
      externalId?: string;
      payload: Record<string, unknown>;
    }): Promise<string> {
      const result = (await bridgeCall(appId, "writeEvent", event)) as { id: string };
      return result.id;
    },
  };
}
