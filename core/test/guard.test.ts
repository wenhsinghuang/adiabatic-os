import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { openDB } from "../src/db";
import { Guard } from "../src/guard";
import { mkdtempSync, rmSync, mkdirSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

describe("Guard", () => {
  let workspace: string;
  let db: ReturnType<typeof openDB>["db"];
  let close: () => void;
  let guard: Guard;

  beforeEach(() => {
    workspace = mkdtempSync(join(tmpdir(), "adiabatic-test-"));
    mkdirSync(join(workspace, ".adiabatic"), { recursive: true });
    const result = openDB(workspace);
    db = result.db;
    close = result.close;
    guard = new Guard({ db, source: "system:test" });
  });

  afterEach(() => {
    close();
    rmSync(workspace, { recursive: true, force: true });
  });

  // -- writeDoc --

  test("writeDoc inserts a new doc", () => {
    guard.writeDoc("journal/today", "# Hello World");
    const doc = guard.queryOne("SELECT * FROM docs WHERE id = ?", ["journal/today"]) as any;

    expect(doc).toBeTruthy();
    expect(doc.id).toBe("journal/today");
    expect(doc.content).toBe("# Hello World");
    expect(doc.created_at).toBeGreaterThan(0);
  });

  test("writeDoc upserts existing doc", () => {
    guard.writeDoc("test/doc", "version 1");
    guard.writeDoc("test/doc", "version 2");

    const doc = guard.queryOne("SELECT * FROM docs WHERE id = ?", ["test/doc"]) as any;
    expect(doc.content).toBe("version 2");
  });

  test("writeDoc auto-logs D0 event", () => {
    guard.writeDoc("test/doc", "hello");

    const events = guard.query(
      "SELECT * FROM events WHERE type = 'd1.write' AND source = 'system:test'"
    ) as any[];
    expect(events.length).toBe(1);

    const payload = JSON.parse(events[0].payload);
    expect(payload.doc_id).toBe("test/doc");
    expect(payload.bytes).toBeGreaterThan(0);
  });

  test("writeDoc with locked metadata skips D0 log", () => {
    guard.writeDoc("private/doc", "secret stuff", { locked: true });

    const events = guard.query(
      "SELECT * FROM events WHERE type = 'd1.write'"
    ) as any[];
    expect(events.length).toBe(0);
  });

  // -- deleteDoc --

  test("deleteDoc removes doc and logs snapshot", () => {
    guard.writeDoc("to-delete", "important content");
    const deleted = guard.deleteDoc("to-delete");

    expect(deleted).toBe(true);

    // Doc should be gone
    const doc = guard.queryOne("SELECT * FROM docs WHERE id = ?", ["to-delete"]);
    expect(doc).toBeNull();

    // D0 should have full snapshot
    const events = guard.query(
      "SELECT * FROM events WHERE type = 'd1.delete'"
    ) as any[];
    expect(events.length).toBe(1);

    const payload = JSON.parse(events[0].payload);
    expect(payload.doc_id).toBe("to-delete");
    expect(payload.content).toBe("important content");
  });

  test("deleteDoc returns false for non-existent doc", () => {
    expect(guard.deleteDoc("nope")).toBe(false);
  });

  // -- writeEvent --

  test("writeEvent inserts D0 event", () => {
    const id = guard.writeEvent({
      source: "connector:oura",
      type: "sleep.recorded",
      startedAt: Date.now() - 28800000,
      endedAt: Date.now(),
      payload: { duration_hours: 8 },
    });

    expect(id).toBeTruthy();
    expect(id.length).toBe(26); // ULID length

    const event = guard.queryOne("SELECT * FROM events WHERE id = ?", [id]) as any;
    expect(event.source).toBe("connector:oura");
    expect(event.type).toBe("sleep.recorded");
  });

  // -- write (D2) --

  test("write creates D2 table and auto-logs D0", () => {
    guard.write("CREATE TABLE IF NOT EXISTS focus_sessions (id TEXT PRIMARY KEY, duration INTEGER)");
    guard.write("INSERT INTO focus_sessions (id, duration) VALUES (?, ?)", ["s1", 3600]);

    const rows = guard.query("SELECT * FROM focus_sessions") as any[];
    expect(rows.length).toBe(1);
    expect(rows[0].duration).toBe(3600);

    // Should have D0 events for both DDL and DML
    const events = guard.query(
      "SELECT * FROM events WHERE source = 'system:test' ORDER BY created_at"
    ) as any[];
    const types = events.map((e: any) => e.type);
    expect(types).toContain("ddl.promote");
    expect(types).toContain("d2.insert");
  });

  test("write rejects unsupported operations", () => {
    expect(() => guard.write("SELECT * FROM events")).toThrow("unsupported write operation");
  });

  // -- query --

  test("query returns results", () => {
    guard.writeDoc("q/1", "one");
    guard.writeDoc("q/2", "two");

    const docs = guard.query("SELECT id FROM docs WHERE id LIKE 'q/%' ORDER BY id") as any[];
    expect(docs.length).toBe(2);
    expect(docs[0].id).toBe("q/1");
    expect(docs[1].id).toBe("q/2");
  });

  test("queryOne returns single result or null", () => {
    guard.writeDoc("single", "hello");

    const doc = guard.queryOne("SELECT * FROM docs WHERE id = ?", ["single"]);
    expect(doc).toBeTruthy();

    const missing = guard.queryOne("SELECT * FROM docs WHERE id = ?", ["nope"]);
    expect(missing).toBeNull();
  });
});
