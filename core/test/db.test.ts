import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { openDB } from "../src/db";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { mkdirSync } from "fs";

describe("DB", () => {
  let workspace: string;

  beforeEach(() => {
    workspace = mkdtempSync(join(tmpdir(), "adiabatic-test-"));
    mkdirSync(join(workspace, ".adiabatic"), { recursive: true });
  });

  afterEach(() => {
    rmSync(workspace, { recursive: true, force: true });
  });

  test("opens and creates schema", () => {
    const { db, close } = openDB(workspace);

    // Check events table exists
    const events = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='events'"
    ).get();
    expect(events).toBeTruthy();

    // Check docs table exists
    const docs = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='docs'"
    ).get();
    expect(docs).toBeTruthy();

    const connectorIntegrations = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='connector_integrations'"
    ).get();
    expect(connectorIntegrations).toBeTruthy();

    close();
  });

  test("events table has correct columns", () => {
    const { db, close } = openDB(workspace);
    const columns = db.prepare("PRAGMA table_info(events)").all() as { name: string }[];
    const names = columns.map((c) => c.name);

    expect(names).toContain("id");
    expect(names).toContain("schema_version");
    expect(names).toContain("source");
    expect(names).toContain("type");
    expect(names).toContain("external_id");
    expect(names).toContain("started_at");
    expect(names).toContain("ended_at");
    expect(names).toContain("payload");
    expect(names).toContain("created_at");

    close();
  });

  test("connector integrations table has runtime state columns", () => {
    const { db, close } = openDB(workspace);
    const columns = db.prepare("PRAGMA table_info(connector_integrations)").all() as { name: string }[];
    const names = columns.map((c) => c.name);

    expect(names).toContain("id");
    expect(names).toContain("connector_id");
    expect(names).toContain("enabled");
    expect(names).toContain("status");
    expect(names).toContain("config");
    expect(names).toContain("sync_state");
    expect(names).toContain("auth_ref");
    expect(names).toContain("last_error");
    expect(names).toContain("last_run_at");
    expect(names).toContain("created_at");
    expect(names).toContain("updated_at");

    close();
  });

  test("events default to current D0 schema version", () => {
    const { db, close } = openDB(workspace);

    db.prepare(
      "INSERT INTO events (id, source, type, started_at, payload) VALUES (?, ?, ?, ?, ?)"
    ).run("e1", "system:test", "test.event", Date.now(), "{}");

    const event = db.prepare("SELECT schema_version FROM events WHERE id = ?").get("e1") as {
      schema_version: string;
    };
    expect(event.schema_version).toBe("0.1");

    close();
  });

  test("openDB migrates legacy events table with schema_version", () => {
    const legacy = new Database(join(workspace, ".adiabatic", "adiabatic.db"), { create: true });
    legacy.exec(`
      CREATE TABLE events (
        id          TEXT PRIMARY KEY,
        source      TEXT NOT NULL,
        type        TEXT NOT NULL,
        external_id TEXT,
        started_at  INTEGER NOT NULL,
        ended_at    INTEGER,
        payload     JSON NOT NULL,
        created_at  INTEGER NOT NULL DEFAULT (unixepoch('subsec')*1000)
      );
    `);
    legacy.prepare(
      "INSERT INTO events (id, source, type, started_at, payload) VALUES (?, ?, ?, ?, ?)"
    ).run("legacy-1", "system:legacy", "legacy.event", Date.now(), "{}");
    legacy.close();

    const { db, close } = openDB(workspace);
    const event = db.prepare("SELECT schema_version FROM events WHERE id = ?").get("legacy-1") as {
      schema_version: string;
    };
    expect(event.schema_version).toBe("0.1");

    close();
  });

  test("docs table has correct columns", () => {
    const { db, close } = openDB(workspace);
    const columns = db.prepare("PRAGMA table_info(docs)").all() as { name: string }[];
    const names = columns.map((c) => c.name);

    expect(names).toContain("id");
    expect(names).toContain("content");
    expect(names).toContain("metadata");
    expect(names).toContain("created_at");
    expect(names).toContain("updated_at");

    close();
  });

  test("events dedup index works", () => {
    const { db, close } = openDB(workspace);

    db.prepare(
      "INSERT INTO events (id, source, type, external_id, started_at, payload) VALUES (?, ?, ?, ?, ?, ?)"
    ).run("e1", "connector:oura", "sleep.recorded", "oura-123", Date.now(), "{}");

    // Same source + external_id should fail
    expect(() =>
      db.prepare(
        "INSERT INTO events (id, source, type, external_id, started_at, payload) VALUES (?, ?, ?, ?, ?, ?)"
      ).run("e2", "connector:oura", "sleep.recorded", "oura-123", Date.now(), "{}")
    ).toThrow();

    // Different source + same external_id should succeed
    db.prepare(
      "INSERT INTO events (id, source, type, external_id, started_at, payload) VALUES (?, ?, ?, ?, ?, ?)"
    ).run("e3", "connector:github", "sleep.recorded", "oura-123", Date.now(), "{}");

    close();
  });

  test("events table is append-only at SQLite trigger level", () => {
    const { db, close } = openDB(workspace);

    db.prepare(
      "INSERT INTO events (id, source, type, started_at, payload) VALUES (?, ?, ?, ?, ?)"
    ).run("e1", "system:test", "test.event", Date.now(), "{}");

    expect(() =>
      db.prepare("UPDATE events SET type = ? WHERE id = ?").run("test.changed", "e1")
    ).toThrow("events are append-only");
    expect(() =>
      db.prepare("DELETE FROM events WHERE id = ?").run("e1")
    ).toThrow("events are append-only");

    close();
  });

  test("WAL mode is enabled", () => {
    const { db, close } = openDB(workspace);
    const result = db.prepare("PRAGMA journal_mode").get() as { journal_mode: string };
    expect(result.journal_mode).toBe("wal");
    close();
  });
});
