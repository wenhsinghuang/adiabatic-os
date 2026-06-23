import { Database } from "bun:sqlite";
import { join } from "path";
import { D0_SCHEMA_VERSION } from "./schema";

export const DATA_DB_FILENAME = "data.db";
export const SYSTEM_DB_FILENAME = "system.db";

// D0 events + D1 docs schema — one-way door, matches design spec exactly.
// D2 app/user tables are created at runtime through Guard.promote().
const DATA_SCHEMA = `
CREATE TABLE IF NOT EXISTS events (
  id          TEXT PRIMARY KEY,
  schema_version TEXT NOT NULL DEFAULT '${D0_SCHEMA_VERSION}',
  source      TEXT NOT NULL,
  type        TEXT NOT NULL,
  external_id TEXT,
  started_at  INTEGER NOT NULL,
  ended_at    INTEGER,
  payload     JSON NOT NULL,
  created_at  INTEGER NOT NULL DEFAULT (unixepoch('subsec')*1000)
);

CREATE INDEX IF NOT EXISTS idx_events_source ON events(source, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_events_type ON events(type, started_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_events_dedup ON events(source, external_id)
  WHERE external_id IS NOT NULL;

CREATE TRIGGER IF NOT EXISTS prevent_events_update
BEFORE UPDATE ON events
BEGIN
  SELECT RAISE(ABORT, 'events are append-only');
END;

CREATE TRIGGER IF NOT EXISTS prevent_events_delete
BEFORE DELETE ON events
BEGIN
  SELECT RAISE(ABORT, 'events are append-only');
END;

CREATE TABLE IF NOT EXISTS docs (
  id          TEXT PRIMARY KEY,
  content     TEXT NOT NULL DEFAULT '',
  metadata    JSON,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_docs_updated ON docs(updated_at DESC);
`;

const SYSTEM_SCHEMA = `
CREATE TABLE IF NOT EXISTS connector_integrations (
  id            TEXT PRIMARY KEY,
  connector_id  TEXT NOT NULL,
  integration_key TEXT,
  enabled       INTEGER NOT NULL DEFAULT 1,
  status        TEXT NOT NULL DEFAULT 'idle',
  setup_status  TEXT NOT NULL DEFAULT 'ready',
  trust_status  TEXT NOT NULL DEFAULT 'missing',
  schedule_cron TEXT,
  next_run_at   INTEGER,
  package_hash  TEXT,
  config        JSON,
  sync_state    JSON,
  requirements_status JSON,
  auth_ref      TEXT,
  last_error    TEXT,
  warnings      JSON,
  last_run_at   INTEGER,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_connector_integrations_connector
  ON connector_integrations(connector_id);
CREATE INDEX IF NOT EXISTS idx_connector_integrations_status
  ON connector_integrations(status);
CREATE UNIQUE INDEX IF NOT EXISTS idx_connector_integrations_identity
  ON connector_integrations(connector_id, integration_key)
  WHERE integration_key IS NOT NULL;

CREATE TABLE IF NOT EXISTS connector_custom_approvals (
  connector_id   TEXT NOT NULL,
  approved_hash  TEXT NOT NULL,
  approved_at    INTEGER NOT NULL,
  PRIMARY KEY (connector_id, approved_hash)
);

CREATE TABLE IF NOT EXISTS auth_accounts (
  id          TEXT PRIMARY KEY,
  label       TEXT,
  subject     TEXT,
  created_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS auth_secret_items (
  id          TEXT PRIMARY KEY,
  ciphertext  TEXT NOT NULL,
  nonce       TEXT NOT NULL,
  algorithm   TEXT NOT NULL,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS auth_credentials (
  id                TEXT PRIMARY KEY,
  kind              TEXT NOT NULL,
  account_id        TEXT REFERENCES auth_accounts(id),
  owner_type        TEXT NOT NULL,
  owner_id          TEXT NOT NULL,
  scopes_json       JSON,
  status            TEXT NOT NULL,
  secret_item_id    TEXT NOT NULL REFERENCES auth_secret_items(id) ON DELETE CASCADE,
  expires_at        INTEGER,
  metadata          JSON,
  status_changed_at INTEGER NOT NULL,
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_auth_credentials_owner
  ON auth_credentials(owner_type, owner_id);
CREATE INDEX IF NOT EXISTS idx_auth_credentials_status
  ON auth_credentials(status);
`;

export interface AdiabaticDatabases {
  dataDb: Database;
  systemDb: Database;
  close(): void;
}

export function openDatabases(workspacePath: string): AdiabaticDatabases {
  const adiabaticDir = join(workspacePath, ".adiabatic");
  const dataDb = new Database(join(adiabaticDir, DATA_DB_FILENAME), { create: true });
  const systemDb = new Database(join(adiabaticDir, SYSTEM_DB_FILENAME), { create: true });

  applyPragmas(dataDb);
  applyPragmas(systemDb);

  dataDb.exec(DATA_SCHEMA);
  systemDb.exec(SYSTEM_SCHEMA);

  return {
    dataDb,
    systemDb,
    close() {
      dataDb.close();
      systemDb.close();
    },
  };
}

function applyPragmas(db: Database): void {
  db.run("PRAGMA journal_mode = WAL");
  db.run("PRAGMA synchronous = NORMAL");
  db.run("PRAGMA foreign_keys = ON");
}
