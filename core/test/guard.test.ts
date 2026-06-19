import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { openDatabases } from "../src/db";
import { Guard } from "../src/guard";
import { mkdtempSync, rmSync, mkdirSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

describe("Guard", () => {
  let workspace: string;
  let dataDb: ReturnType<typeof openDatabases>["dataDb"];
  let close: () => void;
  let guard: Guard;

  beforeEach(() => {
    workspace = mkdtempSync(join(tmpdir(), "adiabatic-test-"));
    mkdirSync(join(workspace, ".adiabatic"), { recursive: true });
    const result = openDatabases(workspace);
    dataDb = result.dataDb;
    close = result.close;
    guard = new Guard({ db: dataDb, source: "system:test" });
  });

  afterEach(() => {
    close();
    rmSync(workspace, { recursive: true, force: true });
  });

  // -- writeDoc --

  test("cannot query system database tables", () => {
    expect(() => guard.query("SELECT * FROM connector_integrations")).toThrow("no such table");
  });

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
    expect(payload.patch).toContain("--- /dev/null");
    expect(payload.patch).toContain("+++ b/test/doc");
    expect(payload.patch).toContain("+hello");
    expect(payload.before).toBeUndefined();
    expect(payload.after).toBeUndefined();
    expect(payload.bytes).toBeGreaterThan(0);
  });

  test("writeDoc with locked metadata skips D0 log", () => {
    guard.writeDoc("private/doc", "secret stuff", { locked: true });

    const events = guard.query(
      "SELECT * FROM events WHERE type = 'd1.write'"
    ) as any[];
    expect(events.length).toBe(0);
  });

  test("writeDoc rejects unsafe doc ids", () => {
    expect(() => guard.writeDoc("../outside", "nope")).toThrow("Invalid doc id");
    expect(() => guard.writeDoc("/tmp/outside", "nope")).toThrow("Invalid doc id");
    expect(() => guard.writeDoc("folder/../outside", "nope")).toThrow("Invalid doc id");
    expect(() => guard.writeDoc("folder//outside", "nope")).toThrow("Invalid doc id");
    expect(() => guard.writeDoc("folder\\outside", "nope")).toThrow("Invalid doc id");
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

  test("deleteDoc rejects unsafe doc ids", () => {
    expect(() => guard.deleteDoc("../outside")).toThrow("Invalid doc id");
  });

  // -- writeEvent --

  test("writeEvent injects Guard source", () => {
    const connectorGuard = guard.withSource("connector:oura");
    const id = connectorGuard.writeEvent({
      type: "sleep.recorded",
      startedAt: Date.now() - 28800000,
      endedAt: Date.now(),
      payload: { duration_hours: 8 },
    });

    expect(id).toBeTruthy();
    expect(id.length).toBe(26); // ULID length

    const event = guard.queryOne("SELECT * FROM events WHERE id = ?", [id]) as any;
    expect(event.schema_version).toBe("0.1");
    expect(event.source).toBe("connector:oura");
    expect(event.type).toBe("sleep.recorded");
  });

  test("writeEvent reserves system event namespaces for system sources", () => {
    const appGuard = guard.withSource("app:tracker");
    for (const type of [
      "connector.installed",
      "connector.approved",
      "d1.write",
      "d2.write",
      "ddl.promote",
      "app.created",
      "app.archived",
    ]) {
      expect(() =>
        appGuard.writeEvent({ type, startedAt: Date.now(), payload: { connector_id: "x" } }),
      ).toThrow("system-reserved");
    }

    const connectorGuard = guard.withSource("connector:evil");
    expect(() =>
      connectorGuard.writeEvent({
        type: "connector.installed",
        startedAt: Date.now(),
        payload: { connector_id: "app-commits" },
      }),
    ).toThrow("system-reserved");

    // System code writes lifecycle records; non-reserved types stay open to all.
    expect(
      guard.writeEvent({
        type: "connector.installed",
        startedAt: Date.now(),
        payload: { connector_id: "ok" },
      }),
    ).toBeTruthy();
    expect(
      connectorGuard.writeEvent({ type: "oura.sample", startedAt: Date.now(), payload: {} }),
    ).toBeTruthy();
    // app.commit is connector-emitted, so it must stay open to connector sources.
    expect(
      connectorGuard.writeEvent({
        type: "app.commit",
        externalId: "app:abc",
        startedAt: Date.now(),
        payload: { appId: "x", commitSha: "abc" },
      }),
    ).toBeTruthy();
  });

  test("writeEvent accepts any JSON payload shape", () => {
    const payloads = [
      "raw text",
      ["a", 1, true, null],
      null,
      42,
      false,
    ] as const;

    for (const [i, payload] of payloads.entries()) {
      guard.writeEvent({
        type: `json.payload.${i}`,
        startedAt: Date.now(),
        payload,
      });
    }

    const events = guard.query(
      "SELECT payload FROM events WHERE type LIKE 'json.payload.%' ORDER BY type"
    ) as any[];
    expect(events.map((event) => JSON.parse(event.payload))).toEqual(payloads);
  });

  test("writeEvent rejects non-JSON payload values", () => {
    expect(() =>
      guard.writeEvent({
        type: "bad.payload",
        startedAt: Date.now(),
        payload: { missing: undefined } as any,
      })
    ).toThrow("must not be undefined");

    expect(() =>
      guard.writeEvent({
        type: "bad.payload",
        startedAt: Date.now(),
        payload: 1n as any,
      })
    ).toThrow("JSON-serializable");
  });

  // -- write (D2) --

  test("write runs DML and auto-logs D0", () => {
    dataDb.run("CREATE TABLE focus_sessions (id TEXT PRIMARY KEY, duration INTEGER)");
    guard.write("INSERT INTO focus_sessions (id, duration) VALUES (?, ?)", ["s1", 3600]);

    const rows = guard.query("SELECT * FROM focus_sessions") as any[];
    expect(rows.length).toBe(1);
    expect(rows[0].duration).toBe(3600);

    const events = guard.query(
      "SELECT * FROM events WHERE source = 'system:test' ORDER BY created_at"
    ) as any[];
    const types = events.map((e: any) => e.type);
    expect(types).toContain("d2.insert");

    const payload = JSON.parse(events.at(-1).payload);
    expect(payload.op).toBe("insert");
    expect(payload.table).toBe("focus_sessions");
    expect(payload.primary_key).toEqual([{ id: "s1" }]);
    expect(payload.before).toBeNull();
    expect(payload.after).toEqual([{ id: "s1", duration: 3600 }]);
    expect(payload.affected_rows).toBe(1);
    expect(payload.schema_version).toBe("0.1");
    expect(payload.sql).toBe("INSERT INTO focus_sessions (id, duration) VALUES (?, ?)");
    expect(payload.params).toEqual(["s1", 3600]);
  });

  test("write logs update and delete snapshots", () => {
    dataDb.run("CREATE TABLE focus_sessions (id TEXT PRIMARY KEY, duration INTEGER)");
    guard.write("INSERT INTO focus_sessions (id, duration) VALUES (?, ?)", ["s1", 3600]);
    guard.write("UPDATE focus_sessions SET duration = ? WHERE id = ?", [4200, "s1"]);
    guard.write("DELETE FROM focus_sessions WHERE id = ?", ["s1"]);

    const events = guard.query(
      "SELECT type, payload FROM events WHERE type LIKE 'd2.%' ORDER BY created_at"
    ) as any[];
    expect(events.map((event) => event.type)).toEqual(["d2.insert", "d2.update", "d2.delete"]);

    const update = JSON.parse(events[1].payload);
    expect(update.op).toBe("update");
    expect(update.before).toEqual([{ id: "s1", duration: 3600 }]);
    expect(update.after).toEqual([{ id: "s1", duration: 4200 }]);

    const deleted = JSON.parse(events[2].payload);
    expect(deleted.op).toBe("delete");
    expect(deleted.primary_key).toEqual([{ id: "s1" }]);
    expect(deleted.before).toEqual([{ id: "s1", duration: 4200 }]);
    expect(deleted.after).toBeNull();
  });

  test("write enforces app table grants", () => {
    dataDb.run("CREATE TABLE allowed_table (id TEXT PRIMARY KEY)");
    dataDb.run("CREATE TABLE denied_table (id TEXT PRIMARY KEY)");
    const appGuard = guard.withSource("app:demo", {
      canWriteTable: (table) => table === "allowed_table",
    });

    appGuard.write("INSERT INTO allowed_table (id) VALUES (?)", ["ok"]);
    expect(() =>
      appGuard.write("INSERT INTO denied_table (id) VALUES (?)", ["no"])
    ).toThrow("is not allowed to write table");
  });

  test("write rejects schema operations", () => {
    expect(() =>
      guard.write("CREATE TABLE focus_sessions (id TEXT PRIMARY KEY)")
    ).toThrow("system.write only supports INSERT, UPDATE, DELETE");
    expect(() => guard.write("DROP TABLE focus_sessions")).toThrow(
      "system.write only supports INSERT, UPDATE, DELETE",
    );
    expect(() => guard.write("ALTER TABLE focus_sessions ADD COLUMN x TEXT")).toThrow(
      "system.write only supports INSERT, UPDATE, DELETE",
    );
    expect(() => guard.write("PRAGMA table_info(focus_sessions)")).toThrow(
      "system.write only supports INSERT, UPDATE, DELETE",
    );
    expect(() => guard.write("ATTACH DATABASE 'x' AS other")).toThrow(
      "system.write only supports INSERT, UPDATE, DELETE",
    );
  });

  test("write rejects multiple statements", () => {
    dataDb.run("CREATE TABLE focus_sessions (id TEXT PRIMARY KEY, duration INTEGER)");
    expect(() =>
      guard.write("INSERT INTO focus_sessions (id, duration) VALUES ('s1', 1); DELETE FROM focus_sessions")
    ).toThrow("one DML statement");
  });

  test("write allows semicolons inside SQL string literals", () => {
    dataDb.run("CREATE TABLE notes (id TEXT PRIMARY KEY, body TEXT)");
    guard.write("INSERT INTO notes (id, body) VALUES (?, 'one; two')", ["n1"]);

    const row = guard.queryOne("SELECT body FROM notes WHERE id = ?", ["n1"]) as any;
    expect(row.body).toBe("one; two");
  });

  test("write rejects system table writes", () => {
    expect(() =>
      guard.write("INSERT INTO events (id, source, type, started_at, payload) VALUES (?, ?, ?, ?, ?)", [
        "e1",
        "system:test",
        "test.event",
        Date.now(),
        "{}",
      ])
    ).toThrow("system table writes are not allowed: events");
    expect(() => guard.write("UPDATE docs SET content = ? WHERE id = ?", ["nope", "doc"])).toThrow(
      "system table writes are not allowed: docs",
    );
  });

  test("write rejects unsupported operations", () => {
    expect(() => guard.write("SELECT * FROM events")).toThrow("system.write only supports");
  });

  // -- promote / demote --

  test("promote and demote require approval", () => {
    expect(() => guard.promote("CREATE TABLE memories (id TEXT PRIMARY KEY)")).toThrow(
      "requires approval",
    );
    expect(() => guard.demote("DROP TABLE memories")).toThrow("requires approval");
  });

  test("promote accepts allowlisted DDL and logs schema audit", () => {
    guard.promote([
      "CREATE TABLE memories (id TEXT PRIMARY KEY, body TEXT)",
      "CREATE INDEX memories_body_idx ON memories (body)",
      "ALTER TABLE memories ADD COLUMN source TEXT",
    ], { approved: true, requestedBy: "test" });

    const table = guard.queryOne(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'memories'"
    ) as any;
    expect(table.name).toBe("memories");

    const events = guard.query("SELECT * FROM events WHERE type = 'ddl.promote'") as any[];
    expect(events.length).toBe(1);
    const payload = JSON.parse(events[0].payload);
    expect(payload.ddl.length).toBe(3);
    expect(payload.before_schema).toBeTruthy();
    expect(payload.after_schema.tables.some((item: any) => item.name === "memories")).toBe(true);
    expect(payload.requested_by).toBe("test");
  });

  test("promote refuses system-DB table names in data.db", () => {
    // Connector control-plane tables live in system.db; an app D2 promote must
    // not squat their names (or the auth_ prefix) in data.db.
    for (const table of ["connector_integrations", "connector_custom_approvals", "auth_credentials"]) {
      expect(() =>
        guard.promote(`CREATE TABLE ${table} (id TEXT PRIMARY KEY)`, { approved: true }),
      ).toThrow("system table");
    }
  });

  test("demote accepts allowlisted DDL and logs schema audit", () => {
    guard.promote("CREATE TABLE scratch (id TEXT PRIMARY KEY)", { approved: true });
    guard.demote("DROP TABLE scratch", { approved: true, requestedBy: "cleanup" });

    const table = guard.queryOne(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'scratch'"
    );
    expect(table).toBeNull();

    const events = guard.query("SELECT * FROM events WHERE type = 'ddl.demote'") as any[];
    expect(events.length).toBe(1);
    const payload = JSON.parse(events[0].payload);
    expect(payload.ddl).toEqual(["DROP TABLE scratch"]);
    expect(payload.requested_by).toBe("cleanup");
  });

  test("promote and demote reject disallowed DDL and system tables", () => {
    expect(() => guard.promote("DROP TABLE docs", { approved: true })).toThrow("system table");
    expect(() => guard.promote("ALTER TABLE events ADD COLUMN nope TEXT", { approved: true })).toThrow(
      "system table",
    );
    expect(() => guard.promote("CREATE INDEX docs_content_idx ON docs (content)", { approved: true })).toThrow(
      "system table",
    );
    expect(() => guard.demote("CREATE TABLE nope (id TEXT)", { approved: true })).toThrow(
      "demote DDL is not allowed",
    );
    expect(() => guard.demote("DROP TABLE docs", { approved: true })).toThrow("system table");
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

  test("query supports read-only WITH and PRAGMA statements", () => {
    guard.writeDoc("q/1", "one");

    const withRows = guard.query(
      "WITH recent AS (SELECT id FROM docs WHERE id = ?) SELECT id FROM recent",
      ["q/1"],
    ) as any[];
    expect(withRows).toEqual([{ id: "q/1" }]);

    const columns = guard.query("PRAGMA table_info(docs)") as any[];
    expect(columns.some((column) => column.name === "content")).toBe(true);
  });

  test("query rejects writes and multi-statement SQL", () => {
    dataDb.run("CREATE TABLE scratch (id TEXT PRIMARY KEY)");

    expect(() => guard.query("INSERT INTO scratch (id) VALUES ('x')")).toThrow(
      "readonly database",
    );
    expect(() => guard.query("PRAGMA user_version = 2")).toThrow("readonly database");
    expect(() => guard.query("SELECT * FROM docs; SELECT * FROM events")).toThrow(
      "one read-only statement",
    );

    const rows = dataDb.prepare("SELECT * FROM scratch").all();
    expect(rows).toEqual([]);
  });

  test("queryOne returns single result or null", () => {
    guard.writeDoc("single", "hello");

    const doc = guard.queryOne("SELECT * FROM docs WHERE id = ?", ["single"]);
    expect(doc).toBeTruthy();

    const missing = guard.queryOne("SELECT * FROM docs WHERE id = ?", ["nope"]);
    expect(missing).toBeNull();
  });
});
