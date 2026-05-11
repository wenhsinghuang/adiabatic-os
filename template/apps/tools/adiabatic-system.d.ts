declare module "@adiabatic/system" {
  export const system: {
    query(sql: string, params?: unknown[]): Promise<{ rows: unknown[] }>;
    write(sql: string, params?: unknown[]): Promise<{ ok: true }>;
    writeDoc(id: string, content: string, metadata?: Record<string, unknown>): Promise<{ ok: true; id: string }>;
    deleteDoc(id: string): Promise<{ ok: true }>;
    writeEvent(event: {
      type: string;
      startedAt: number;
      endedAt?: number;
      externalId?: string;
      payload: Record<string, unknown>;
    }): Promise<{ ok: true; id: string }>;
  };
}
