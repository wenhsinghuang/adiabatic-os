import { Database } from "bun:sqlite";
import { join } from "path";

// D0 events + D1 docs schema — one-way door, matches design spec exactly

const SCHEMA = `
CREATE TABLE IF NOT EXISTS events (
  id          TEXT PRIMARY KEY,
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

CREATE TABLE IF NOT EXISTS docs (
  id          TEXT PRIMARY KEY,
  content     TEXT NOT NULL DEFAULT '',
  metadata    JSON,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_docs_updated ON docs(updated_at DESC);
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

  return {
    db,
    close() {
      db.close();
    },
  };
}
