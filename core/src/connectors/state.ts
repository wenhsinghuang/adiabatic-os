import type { Database } from "bun:sqlite";
import type {
  ConnectorIntegration,
  ConnectorIntegrationStatus,
  ConnectorRequirementRecord,
  ConnectorSetupStatus,
  ConnectorTrustStatus,
} from "./types";
import { validateConnectorId, validateIntegrationKey } from "./manifest";
import { ulid } from "../utils/ulid";

interface IntegrationRow {
  id: string;
  connector_id: string;
  integration_key: string | null;
  enabled: number;
  status: ConnectorIntegrationStatus;
  setup_status: ConnectorSetupStatus;
  trust_status: ConnectorTrustStatus;
  schedule_cron: string | null;
  next_run_at: number | null;
  package_hash: string | null;
  config: string | null;
  sync_state: string | null;
  requirements_status: string | null;
  auth_ref: string | null;
  last_error: string | null;
  last_run_at: number | null;
  created_at: number;
  updated_at: number;
}

export interface EnsureIntegrationInput<TConfig = unknown> {
  id?: string;
  connectorId: string;
  integrationKey?: string;
  enabled?: boolean;
  setupStatus?: ConnectorSetupStatus;
  trustStatus?: ConnectorTrustStatus;
  scheduleCron?: string | null;
  nextRunAt?: number | null;
  packageHash?: string;
  config?: TConfig;
  authRef?: string;
}

export type UpdateIntegrationInput<TConfig = unknown> = Omit<
  EnsureIntegrationInput<TConfig>,
  "id" | "connectorId"
>;

export class ConnectorIntegrationStore {
  constructor(private db: Database) {}

  ensure<TConfig = unknown, TState = unknown>(
    input: EnsureIntegrationInput<TConfig>,
  ): ConnectorIntegration<TConfig, TState> {
    validateConnectorId(input.connectorId);
    const integrationKey = normalizeIntegrationKey(input.integrationKey);

    const existing = input.id
      ? this.get<TConfig, TState>(input.id)
      : this.getByIdentity<TConfig, TState>(input.connectorId, integrationKey);
    const now = Date.now();
    if (existing) {
      if (existing.connectorId !== input.connectorId) {
        throw new Error(`Connector integration ${existing.id} belongs to ${existing.connectorId}`);
      }
      const nextConfig = input.config === undefined ? existing.config : input.config;
      const nextEnabled = input.enabled ?? existing.enabled;
      const nextSetup = input.setupStatus ?? existing.setupStatus;
      const nextIntegrationKey = input.integrationKey === undefined
        ? existing.integrationKey
        : integrationKey;
      validateIntegrationKeyTransition(existing, nextIntegrationKey);
      this.assertIdentityAvailable(existing.connectorId, nextIntegrationKey, existing.id);
      // A setup-blocked error (run gate failed while setup_status was "setup")
      // resets to idle when the integration is promoted back to ready, so the
      // watch scheduler can pick it up again. A run error on an already-ready
      // integration is preserved.
      const recoveredFromSetup = existing.status === "setup"
        || (existing.status === "error" && existing.setupStatus === "setup");
      const nextStatus: ConnectorIntegrationStatus = nextEnabled
        ? nextSetup === "setup" ? "setup" : existing.status === "disabled" || recoveredFromSetup ? "idle" : existing.status
        : "disabled";
      // Recovery into idle clears the stale failure message; a preserved run
      // error keeps its message.
      const nextLastError = nextStatus === "idle" && existing.status !== "idle"
        ? null
        : existing.lastError ?? null;
      const nextScheduleCron = input.scheduleCron === undefined
        ? existing.scheduleCron
        : input.scheduleCron ?? undefined;
      const nextRunAt = input.nextRunAt === undefined
        ? existing.nextRunAt
        : input.nextRunAt ?? undefined;
      const nextPackageHash = input.packageHash ?? existing.packageHash;
      const nextTrustStatus = input.trustStatus ?? existing.trustStatus;
      const nextAuthRef = input.authRef ?? existing.authRef ?? defaultAuthRef(existing.id);
      this.db.prepare(
        `UPDATE connector_integrations
         SET enabled = ?,
             integration_key = ?,
             status = ?,
             setup_status = ?,
             trust_status = ?,
             schedule_cron = ?,
             next_run_at = ?,
             package_hash = ?,
             config = ?,
             auth_ref = ?,
             last_error = ?,
             updated_at = ?
         WHERE id = ?`
      ).run(
        nextEnabled ? 1 : 0,
        nextIntegrationKey ?? null,
        nextStatus,
        nextSetup,
        nextTrustStatus,
        nextScheduleCron ?? null,
        nextRunAt ?? null,
        nextPackageHash ?? null,
        stringifyJson(nextConfig),
        nextAuthRef ?? null,
        nextLastError,
        now,
        existing.id,
      );
      return this.get<TConfig, TState>(existing.id)!;
    }

    const enabled = input.enabled ?? true;
    const id = input.id ?? newIntegrationId();
    const setupStatus = input.setupStatus ?? "ready";
    const status: ConnectorIntegrationStatus = enabled
      ? setupStatus === "setup" ? "setup" : "idle"
      : "disabled";
    this.db.prepare(
      `INSERT INTO connector_integrations
       (id, connector_id, integration_key, enabled, status, setup_status, trust_status,
        schedule_cron, next_run_at, package_hash, config, sync_state, auth_ref, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      id,
      input.connectorId,
      integrationKey ?? null,
      enabled ? 1 : 0,
      status,
      setupStatus,
      input.trustStatus ?? "missing",
      input.scheduleCron ?? null,
      input.nextRunAt ?? null,
      input.packageHash ?? null,
      stringifyJson(input.config),
      null,
      input.authRef ?? defaultAuthRef(id),
      now,
      now,
    );
    return this.get<TConfig, TState>(id)!;
  }

  update<TConfig = unknown, TState = unknown>(
    id: string,
    input: UpdateIntegrationInput<TConfig>,
  ): ConnectorIntegration<TConfig, TState> {
    const existing = this.get(id);
    if (!existing) {
      throw new Error(`Connector integration not found: ${id}`);
    }
    return this.ensure<TConfig, TState>({
      ...input,
      id,
      connectorId: existing.connectorId,
    });
  }

  get<TConfig = unknown, TState = unknown>(
    id: string,
  ): ConnectorIntegration<TConfig, TState> | undefined {
    const row = this.db.prepare("SELECT * FROM connector_integrations WHERE id = ?").get(id) as IntegrationRow | null;
    return row ? rowToIntegration<TConfig, TState>(row) : undefined;
  }

  getByIdentity<TConfig = unknown, TState = unknown>(
    connectorId: string,
    integrationKey?: string,
  ): ConnectorIntegration<TConfig, TState> | undefined {
    validateConnectorId(connectorId);
    const key = normalizeIntegrationKey(integrationKey);
    const row = key
      ? this.db.prepare(
        `SELECT * FROM connector_integrations
         WHERE connector_id = ? AND integration_key = ?
         ORDER BY created_at
         LIMIT 1`
      ).get(connectorId, key) as IntegrationRow | null
      : this.db.prepare(
        `SELECT * FROM connector_integrations
         WHERE connector_id = ? AND integration_key IS NULL
         ORDER BY created_at
         LIMIT 1`
      ).get(connectorId) as IntegrationRow | null;
    return row ? rowToIntegration<TConfig, TState>(row) : undefined;
  }

  list(): ConnectorIntegration[] {
    return (this.db.prepare("SELECT * FROM connector_integrations ORDER BY connector_id, integration_key").all() as IntegrationRow[])
      .map((row) => rowToIntegration(row));
  }

  setState<TState>(id: string, state: TState): void {
    this.updateJsonColumn(id, "sync_state", state);
  }

  setRequirementsStatus(id: string, value: Record<string, ConnectorRequirementRecord>): void {
    this.updateJsonColumn(id, "requirements_status", value);
  }

  setStatus(id: string, status: ConnectorIntegrationStatus, error?: string): void {
    const now = Date.now();
    this.db.prepare(
      `UPDATE connector_integrations
       SET status = ?, last_error = ?, updated_at = ?, last_run_at = CASE WHEN ? THEN ? ELSE last_run_at END
       WHERE id = ?`
    ).run(status, error ?? null, now, status === "idle" ? 1 : 0, now, id);
  }

  setTrustForConnector(connectorId: string, trustStatus: ConnectorTrustStatus, packageHash?: string): void {
    validateConnectorId(connectorId);
    this.db.prepare(
      `UPDATE connector_integrations
       SET trust_status = ?, package_hash = COALESCE(?, package_hash), updated_at = ?
       WHERE connector_id = ?`
    ).run(trustStatus, packageHash ?? null, Date.now(), connectorId);
  }

  private updateJsonColumn(id: string, column: "config" | "sync_state" | "requirements_status", value: unknown): void {
    this.db.prepare(
      `UPDATE connector_integrations SET ${column} = ?, updated_at = ? WHERE id = ?`
    ).run(stringifyJson(value), Date.now(), id);
  }

  private assertIdentityAvailable(
    connectorId: string,
    integrationKey: string | undefined,
    currentId: string,
  ): void {
    if (!integrationKey) return;
    const existing = this.getByIdentity(connectorId, integrationKey);
    if (existing && existing.id !== currentId) {
      throw new Error(`Connector integration key is already in use: ${connectorId}:${integrationKey}`);
    }
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

export function newIntegrationId(): string {
  return ulid();
}

export function defaultAuthRef(integrationId: string): string {
  return `connector-integration:${integrationId}:auth`;
}

function normalizeIntegrationKey(key: string | undefined): string | undefined {
  if (key === undefined || key === "") return undefined;
  validateIntegrationKey(key);
  return key;
}

function validateIntegrationKeyTransition(
  existing: ConnectorIntegration,
  nextKey: string | undefined,
): void {
  if (existing.integrationKey === nextKey) return;
  if (existing.integrationKey) {
    throw new Error("Connector integration key rename requires an explicit migration");
  }
  if (existing.setupStatus !== "setup") {
    throw new Error("Connector integration key can only be set during setup");
  }
}

function rowToIntegration<TConfig, TState>(row: IntegrationRow): ConnectorIntegration<TConfig, TState> {
  return {
    id: row.id,
    connectorId: row.connector_id,
    integrationKey: row.integration_key ?? undefined,
    enabled: row.enabled === 1,
    status: row.status,
    setupStatus: row.setup_status,
    trustStatus: row.trust_status,
    scheduleCron: row.schedule_cron ?? undefined,
    nextRunAt: row.next_run_at ?? undefined,
    packageHash: row.package_hash ?? undefined,
    config: parseJson(row.config) as TConfig | undefined,
    syncState: parseJson(row.sync_state) as TState | undefined,
    requirementsStatus: parseJson(row.requirements_status) as
      | Record<string, ConnectorRequirementRecord>
      | undefined,
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
