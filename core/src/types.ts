// Shared types for @adiabatic/core

export type { AdiabaticDB } from "./db";
export type { Guard, EventInput, GuardOptions } from "./guard";
export type { WorkingTree, WorkingTreeOptions } from "./working-tree";
export type { AppManifest, LoadedApp, AppRegistry } from "./app-loader";
export type { SandboxManager, SandboxMessage, SandboxResponse, AppSandbox } from "./sandbox";
export type { RenderOutput, RenderResult, RenderError } from "./renderer";

// System API type — what apps see through the bridge
export interface System {
  query(sql: string, params?: unknown[]): unknown[];
  write(sql: string, params?: unknown[]): void;
  writeDoc(id: string, content: string, metadata?: Record<string, unknown>): void;
  deleteDoc(id: string): boolean;
  writeEvent(event: {
    source: string;
    type: string;
    startedAt: number;
    endedAt?: number;
    externalId?: string;
    payload: Record<string, unknown>;
  }): string;
}
