import type { Database } from "bun:sqlite";
import type { ConnectorIntegration, ConnectorIntegrationStatus } from "./types";
import { validateConnectorId } from "./manifest";

interface IntegrationRow {
  id: string;
  connector_id: string;
  enabled: number;
  status: ConnectorIntegrationStatus;
  config: string | null;
  sync_state: string | null;
  auth_ref: string | null;
  last_error: string | null;
  last_run_at: number | null;
  created_at: number;
  updated_at: number;
}

export interface EnsureIntegrationInput<TConfig = unknown> {
  id?: string;
  connectorId: string;
  enabled?: boolean;
  config?: TConfig;
  authRef?: string;
}

export class ConnectorIntegrationStore {
  constructor(private db: Database) {}

  ensure<TConfig = unknown, TState = unknown>(
    input: EnsureIntegrationInput<TConfig>,
  ): ConnectorIntegration<TConfig, TState> {
    validateConnectorId(input.connectorId);
    const id = input.id ?? input.connectorId;
    validateConnectorId(id);

    const existing = this.get<TConfig, TState>(id);
    const now = Date.now();
    if (existing) {
      const nextConfig = input.config === undefined ? existing.config : input.config;
      const nextEnabled = input.enabled ?? existing.enabled;
      const nextStatus: ConnectorIntegrationStatus = nextEnabled
        ? existing.status === "disabled" ? "idle" : existing.status
        : "disabled";
      this.db.prepare(
        `UPDATE connector_integrations
         SET enabled = ?, status = ?, config = ?, auth_ref = COALESCE(?, auth_ref), updated_at = ?
         WHERE id = ?`
      ).run(
        nextEnabled ? 1 : 0,
        nextStatus,
        stringifyJson(nextConfig),
        input.authRef ?? null,
        now,
        id,
      );
      return this.get<TConfig, TState>(id)!;
    }

    const enabled = input.enabled ?? true;
    this.db.prepare(
      `INSERT INTO connector_integrations
       (id, connector_id, enabled, status, config, sync_state, auth_ref, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      id,
      input.connectorId,
      enabled ? 1 : 0,
      enabled ? "idle" : "disabled",
      stringifyJson(input.config),
      null,
      input.authRef ?? defaultAuthRef(id),
      now,
      now,
    );
    return this.get<TConfig, TState>(id)!;
  }

  get<TConfig = unknown, TState = unknown>(
    id: string,
  ): ConnectorIntegration<TConfig, TState> | undefined {
    const row = this.db.prepare("SELECT * FROM connector_integrations WHERE id = ?").get(id) as IntegrationRow | null;
    return row ? rowToIntegration<TConfig, TState>(row) : undefined;
  }

  list(): ConnectorIntegration[] {
    return (this.db.prepare("SELECT * FROM connector_integrations ORDER BY id").all() as IntegrationRow[])
      .map((row) => rowToIntegration(row));
  }

  setState<TState>(id: string, state: TState): void {
    this.updateJsonColumn(id, "sync_state", state);
  }

  setStatus(id: string, status: ConnectorIntegrationStatus, error?: string): void {
    const now = Date.now();
    this.db.prepare(
      `UPDATE connector_integrations
       SET status = ?, last_error = ?, updated_at = ?, last_run_at = CASE WHEN ? THEN ? ELSE last_run_at END
       WHERE id = ?`
    ).run(status, error ?? null, now, status === "idle" ? 1 : 0, now, id);
  }

  private updateJsonColumn(id: string, column: "config" | "sync_state", value: unknown): void {
    this.db.prepare(
      `UPDATE connector_integrations SET ${column} = ?, updated_at = ? WHERE id = ?`
    ).run(stringifyJson(value), Date.now(), id);
  }
}

export function createConnectorStateHandle<TState>(
  store: ConnectorIntegrationStore,
  instanceId: string,
) {
  return {
    async get(): Promise<TState | undefined> {
      return store.get<unknown, TState>(instanceId)?.syncState;
    },
    async set(state: TState): Promise<void> {
      store.setState(instanceId, state);
    },
  };
}

export function defaultAuthRef(instanceId: string): string {
  return `connector:${instanceId}:auth`;
}

function rowToIntegration<TConfig, TState>(row: IntegrationRow): ConnectorIntegration<TConfig, TState> {
  return {
    id: row.id,
    connectorId: row.connector_id,
    enabled: row.enabled === 1,
    status: row.status,
    config: parseJson(row.config) as TConfig | undefined,
    syncState: parseJson(row.sync_state) as TState | undefined,
    authRef: row.auth_ref ?? undefined,
    lastError: row.last_error ?? undefined,
    lastRunAt: row.last_run_at ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function parseJson(value: string | null): unknown {
  return value === null ? undefined : JSON.parse(value);
}

function stringifyJson(value: unknown): string | null {
  return value === undefined ? null : JSON.stringify(value);
}

