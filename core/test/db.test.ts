import { describe, test, expect, beforeEach, afterEach } from "bun:test";
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

    close();
  });

  test("events table has correct columns", () => {
    const { db, close } = openDB(workspace);
    const columns = db.prepare("PRAGMA table_info(events)").all() as { name: string }[];
    const names = columns.map((c) => c.name);

    expect(names).toContain("id");
    expect(names).toContain("source");
    expect(names).toContain("type");
    expect(names).toContain("external_id");
    expect(names).toContain("started_at");
    expect(names).toContain("ended_at");
    expect(names).toContain("payload");
    expect(names).toContain("created_at");

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

  test("WAL mode is enabled", () => {
    const { db, close } = openDB(workspace);
    const result = db.prepare("PRAGMA journal_mode").get() as { journal_mode: string };
    expect(result.journal_mode).toBe("wal");
    close();
  });
});
