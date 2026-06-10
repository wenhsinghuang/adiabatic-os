import { Database } from "bun:sqlite";
import { join } from "path";
import { D0_SCHEMA_VERSION } from "./schema";

// D0 events + D1 docs schema — one-way door, matches design spec exactly

const SCHEMA = `
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
  last_run_at   INTEGER,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_connector_integrations_connector
  ON connector_integrations(connector_id);
CREATE INDEX IF NOT EXISTS idx_connector_integrations_status
  ON connector_integrations(status);

CREATE TABLE IF NOT EXISTS connector_custom_approvals (
  connector_id   TEXT NOT NULL,
  approved_hash  TEXT NOT NULL,
  approved_at    INTEGER NOT NULL,
  PRIMARY KEY (connector_id, approved_hash)
);
`;

export interface AdiabaticDB {
  db: Database;
  close(): void;
}

export function openDB(workspacePath: string): AdiabaticDB {
  const dbPath = join(workspacePath, ".adiabatic", "adiabatic.db");
  const db = new Database(dbPath, { create: true });

  // Performance pragmas
  db.run("PRAGMA journal_mode = WAL");
  db.run("PRAGMA synchronous = NORMAL");
  db.run("PRAGMA foreign_keys = ON");

  // Apply schema
  db.exec(SCHEMA);
  migrateExistingSchema(db);

  return {
    db,
    close() {
      db.close();
    },
  };
}

function migrateExistingSchema(db: Database): void {
  const eventColumns = db.prepare("PRAGMA table_info(events)").all() as { name: string }[];
  if (!eventColumns.some((column) => column.name === "schema_version")) {
    db.run(`ALTER TABLE events ADD COLUMN schema_version TEXT NOT NULL DEFAULT '${D0_SCHEMA_VERSION}'`);
  }

  const integrationColumns = db.prepare("PRAGMA table_info(connector_integrations)").all() as { name: string }[];
  const hasIntegrationColumn = (name: string) => integrationColumns.some((column) => column.name === name);
  if (!hasIntegrationColumn("integration_key")) {
    db.run("ALTER TABLE connector_integrations ADD COLUMN integration_key TEXT");
  }
  if (!hasIntegrationColumn("setup_status")) {
    db.run("ALTER TABLE connector_integrations ADD COLUMN setup_status TEXT NOT NULL DEFAULT 'ready'");
  }
  if (!hasIntegrationColumn("trust_status")) {
    db.run("ALTER TABLE connector_integrations ADD COLUMN trust_status TEXT NOT NULL DEFAULT 'missing'");
  }
  if (!hasIntegrationColumn("schedule_cron")) {
    db.run("ALTER TABLE connector_integrations ADD COLUMN schedule_cron TEXT");
  }
  if (!hasIntegrationColumn("next_run_at")) {
    db.run("ALTER TABLE connector_integrations ADD COLUMN next_run_at INTEGER");
  }
  if (!hasIntegrationColumn("package_hash")) {
    db.run("ALTER TABLE connector_integrations ADD COLUMN package_hash TEXT");
  }
  if (!hasIntegrationColumn("requirements_status")) {
    db.run("ALTER TABLE connector_integrations ADD COLUMN requirements_status JSON");
  }
  db.run("DROP INDEX IF EXISTS idx_connector_integrations_identity");
  db.run(
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_connector_integrations_identity
     ON connector_integrations(connector_id, integration_key)
     WHERE integration_key IS NOT NULL`
  );
}
