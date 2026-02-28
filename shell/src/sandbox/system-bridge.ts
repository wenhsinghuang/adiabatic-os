// System bridge — provides the system.* API to app components rendered in the browser.
// Routes all calls through HTTP to core's Guard.

import * as api from "../lib/api";

export interface System {
  query(sql: string, params?: unknown[]): Promise<unknown[]>;
  write(sql: string, params?: unknown[]): Promise<void>;
  writeDoc(id: string, content: string, metadata?: Record<string, unknown>): Promise<void>;
  deleteDoc(id: string): Promise<void>;
}

export function createSystemBridge(appId: string): System {
  return {
    async query(sql: string, params?: unknown[]): Promise<unknown[]> {
      const result = await api.query(sql, params);
      return result.rows;
    },

    async write(sql: string, params?: unknown[]): Promise<void> {
      await api.write(sql, params);
    },

    async writeDoc(id: string, content: string, metadata?: Record<string, unknown>): Promise<void> {
      await api.saveDoc(id, content, metadata);
    },

    async deleteDoc(id: string): Promise<void> {
      await api.deleteDoc(id);
    },
  };
}
