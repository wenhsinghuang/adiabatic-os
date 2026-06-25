// Shared types for @adiabatic/core

import type { JsonValue } from "./json";

export type { AdiabaticDB } from "./db";
export type { Guard, EventInput, GuardOptions } from "./guard";
export type { JsonValue } from "./json";
export type { WorkingTree, WorkingTreeOptions } from "./working-tree";
export type { AppManifest, LoadedApp, AppRegistry } from "./app-loader";
export type {
  BoundConnectorGuard,
  ConnectorAuthHandle,
  ConnectorAuthSpec,
  ConnectorDefinition,
  ConnectorEventInput,
  ConnectorIntegration,
  ConnectorIntegrationMode,
  ConnectorIntegrationsSpec,
  ConnectorManifest,
  ConnectorOfficialCatalogEntry,
  ConnectorPackageRecord,
  ConnectorPackageTrust,
  ConnectorPackageTrustStatus,
  ConnectorPlatform,
  ConnectorPlatformsSpec,
  ConnectorPlatformSpec,
  ConnectorRunContext,
  ConnectorRunHandle,
  ConnectorRuntimeMode,
  ConnectorSetupStatus,
  ConnectorStateHandle,
  ConnectorTrustStatus,
  InstalledConnector,
  InstallConnectorOptions,
  RegisterWorkspaceConnectorsOptions,
  UpdateIntegrationInput,
} from "./connectors";

// System API type — what apps see through the bridge
export interface System {
  query(sql: string, params?: unknown[]): unknown[];
  write(sql: string, params?: unknown[]): void;
  writeDoc(id: string, content: string, metadata?: Record<string, unknown>): void;
  deleteDoc(id: string): boolean;
  writeEvent(event: {
    type: string;
    startedAt: number;
    endedAt?: number;
    externalId?: string;
    payload: JsonValue;
  }): string;
}
