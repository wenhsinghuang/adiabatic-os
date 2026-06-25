import type { Database } from "bun:sqlite";
import { ulid } from "./utils/ulid";
import { D0_SCHEMA_VERSION } from "./schema";
import { createUnifiedPatch } from "./utils/unified-diff";
import { validateDocId } from "./doc-id";
import { assertJsonValue, type JsonValue } from "./json";

// Guard — the only write path into the database.
// Every mutation goes through here: permission check → execute → auto D0 log.

export interface EventInput {
  schemaVersion?: string;
  type: string;
  externalId?: string;
  startedAt: number;
  endedAt?: number;
  payload: JsonValue;
}

export interface GuardOptions {
  db: Database;
  source: string; // injected at construction, cannot be forged by app
  canWriteTable?: (table: string) => boolean;
}

type DmlOp = "insert" | "update" | "delete";
export type SchemaOp = "promote" | "demote";

const SYSTEM_TABLES = new Set(["events", "docs"]);
// Table-name prefixes owned by the system DB (connector control-plane, future
// auth). They never live in data.db, so reserving them here only stops an app
// D2 table from squatting a confusing system name — namespace protection, not
// a read denylist (read isolation is the data/system DB split).
const SYSTEM_TABLE_PREFIXES = ["sqlite_", "_adiabatic_", "connector_", "auth_"];

export class Guard {
  private db: Database;
  private source: string;
  private canWriteTable?: (table: string) => boolean;

  // Prepared statements (lazy init)
  private stmts: {
    insertEvent?: ReturnType<Database["prepare"]>;
    upsertDoc?: ReturnType<Database["prepare"]>;
    getDoc?: ReturnType<Database["prepare"]>;
    deleteDoc?: ReturnType<Database["prepare"]>;
  } = {};

  // Listener for doc changes (working tree uses this)
  public onDocChange?: (id: string, content: string | null) => void;

  // Always-fire subscribers for doc changes (SSE etc. — never suppressed by WorkingTree)
  public docChangeSubscribers: Array<(id: string) => void> = [];

  constructor(opts: GuardOptions) {
    this.db = opts.db;
    this.source = opts.source;
    this.canWriteTable = opts.canWriteTable;
  }

  withSource(source: string, opts?: { canWriteTable?: (table: string) => boolean; copyDocHook?: boolean }): Guard {
    const guard = new Guard({
      db: this.db,
      source,
      canWriteTable: opts?.canWriteTable ?? this.canWriteTable,
    });
    guard.docChangeSubscribers = this.docChangeSubscribers;
    if (opts?.copyDocHook !== false) {
      guard.onDocChange = this.onDocChange;
    }
    return guard;
  }

  // -- Read (no permission check, no D0 log) --

  query(sql: string, params?: unknown[]): unknown[] {
    return this.runReadOnly(() => {
      const trimmed = sql.trim();
      validateSingleStatement(trimmed, "system.query");
      const stmt = this.db.prepare(trimmed);
      return params ? stmt.all(...params) : stmt.all();
    });
  }

  queryOne(sql: string, params?: unknown[]): unknown | null {
    return this.runReadOnly(() => {
      const trimmed = sql.trim();
      validateSingleStatement(trimmed, "system.queryOne");
      const stmt = this.db.prepare(trimmed);
      return params ? stmt.get(...params) : stmt.get();
    });
  }

  // -- D0: writeEvent (explicit event, no additional D0 log) --

  writeEvent(event: EventInput): string {
    validateEventInput(event);
    assertEventTypeAllowed(this.source, event.type);
    const id = ulid();
    const stmt = this.stmts.insertEvent ??= this.db.prepare(
      `INSERT INTO events (id, schema_version, source, type, external_id, started_at, ended_at, payload)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    );
    stmt.run(
      id,
      event.schemaVersion ?? D0_SCHEMA_VERSION,
      this.source,
      event.type,
      event.externalId ?? null,
      event.startedAt,
      event.endedAt ?? null,
      JSON.stringify(event.payload),
    );
    return id;
  }

  // -- D1: writeDoc (upsert + auto D0 log) --

  writeDoc(id: string, content: string, metadata?: Record<string, unknown>): void {
    validateDocId(id);

    const now = Date.now();
    const meta = metadata ? JSON.stringify(metadata) : null;

    // Read existing content before upsert (for patch in D0 log)
    const existing = (this.stmts.getDoc ??= this.db.prepare(
      "SELECT id, content, metadata FROM docs WHERE id = ?"
    )).get(id) as { content: string } | null;

    const stmt = this.stmts.upsertDoc ??= this.db.prepare(
      `INSERT INTO docs (id, content, metadata, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         content = excluded.content,
         metadata = COALESCE(excluded.metadata, docs.metadata),
         updated_at = excluded.updated_at`
    );
    this.db.run("BEGIN IMMEDIATE");
    try {
      stmt.run(id, content, meta, now, now);

      // Auto D0 log — store a git-style patch instead of duplicating before/after content.
      const isLocked = metadata?.locked === true;
      if (!isLocked) {
        const before = existing?.content ?? "";
        this.logD0("d1.write", {
          doc_id: id,
          patch: createUnifiedPatch(before, content, {
            oldPath: existing ? `a/${id}` : "/dev/null",
            newPath: `b/${id}`,
          }),
          bytes: Buffer.byteLength(content, "utf8"),
        });
      }
      this.db.run("COMMIT");
    } catch (err) {
      try { this.db.run("ROLLBACK"); } catch {}
      throw err;
    }

    this.onDocChange?.(id, content);
    for (const fn of this.docChangeSubscribers) { try { fn(id); } catch {} }
  }

  // -- D1: deleteDoc (hard delete + auto D0 snapshot) --

  deleteDoc(id: string): boolean {
    validateDocId(id);

    // Read before delete — snapshot for D0 safety net
    const existing = this.stmts.getDoc ??= this.db.prepare(
      "SELECT id, content, metadata FROM docs WHERE id = ?"
    );
    const doc = existing.get(id) as { id: string; content: string; metadata: string } | null;
    if (!doc) return false;

    const stmt = this.stmts.deleteDoc ??= this.db.prepare(
      "DELETE FROM docs WHERE id = ?"
    );
    this.db.run("BEGIN IMMEDIATE");
    try {
      stmt.run(id);

      // D0 log — full snapshot (safety net for hard delete)
      this.logD0("d1.delete", {
        doc_id: id,
        content: doc.content,
        metadata: doc.metadata ? JSON.parse(doc.metadata) : null,
      });
      this.db.run("COMMIT");
    } catch (err) {
      try { this.db.run("ROLLBACK"); } catch {}
      throw err;
    }

    this.onDocChange?.(id, null);
    for (const fn of this.docChangeSubscribers) { try { fn(id); } catch {} }
    return true;
  }

  // -- D2: write (DML + CDC-style auto D0 log) --

  write(sql: string, params?: unknown[]): void {
    const trimmed = sql.trim();
    if (containsStatementSeparator(trimmed)) {
      throw new Error("Guard: system.write accepts one DML statement without semicolons");
    }

    const normalized = trimmed.toUpperCase();
    let op: DmlOp;
    let opType: string;
    let table: string | null = null;

    if (normalized.startsWith("INSERT")) {
      op = "insert";
      opType = "d2.insert";
      table = extractTable(sql, "INTO");
    } else if (normalized.startsWith("UPDATE")) {
      op = "update";
      opType = "d2.update";
      table = extractTable(sql, "UPDATE");
    } else if (normalized.startsWith("DELETE")) {
      op = "delete";
      opType = "d2.delete";
      table = extractTable(sql, "FROM");
    } else {
      throw new Error(
        "Guard: system.write only supports INSERT, UPDATE, DELETE; schema changes require privileged schema APIs",
      );
    }

    if (!table) {
      throw new Error(`Guard: could not determine target table: ${sql.slice(0, 50)}`);
    }
    if (isSystemTable(table)) {
      throw new Error(`Guard: system table writes are not allowed: ${table}`);
    }
    if (this.canWriteTable && !this.canWriteTable(table)) {
      throw new Error(`Guard: source ${this.source} is not allowed to write table: ${table}`);
    }

    this.runDmlWithCdc(op, opType, table, trimmed, params ?? []);
  }

  // -- DDL lifecycle: promote / demote (privileged + auto D0 log) --

  promote(ddl: string | string[], opts?: { approved?: boolean; requestedBy?: string }): void {
    this.runSchemaLifecycle("promote", ddl, opts);
  }

  demote(ddl: string | string[], opts?: { approved?: boolean; requestedBy?: string }): void {
    this.runSchemaLifecycle("demote", ddl, opts);
  }

  schemaPlan(kind: SchemaOp, ddl: string | string[]): {
    kind: SchemaOp;
    ddl: string[];
    before_schema: SchemaSnapshot;
  } {
    const statements = normalizeStatements(ddl);
    for (const statement of statements) {
      validateDdl(this.db, kind, statement);
    }
    dryRunDdl(this.db, statements);
    return {
      kind,
      ddl: statements,
      before_schema: snapshotSchema(this.db),
    };
  }

  private runSchemaLifecycle(
    kind: SchemaOp,
    ddl: string | string[],
    opts?: { approved?: boolean; requestedBy?: string },
  ): void {
    if (!opts?.approved) {
      throw new Error(`Guard: ${kind} requires approval`);
    }

    const statements = normalizeStatements(ddl);
    if (statements.length === 0) {
      throw new Error(`Guard: ${kind} requires at least one DDL statement`);
    }
    for (const statement of statements) {
      validateDdl(this.db, kind, statement);
    }
    dryRunDdl(this.db, statements);

    const before = snapshotSchema(this.db);
    this.db.run("BEGIN IMMEDIATE");
    try {
      for (const statement of statements) {
        this.db.run(statement);
      }
      const after = snapshotSchema(this.db);
      this.logD0(kind === "promote" ? "ddl.promote" : "ddl.demote", {
        ddl: statements,
        before_schema: before,
        after_schema: after,
        requested_by: opts.requestedBy ?? null,
        schema_version: D0_SCHEMA_VERSION,
      });
      this.db.run("COMMIT");
    } catch (err) {
      try { this.db.run("ROLLBACK"); } catch {}
      throw err;
    }
  }

  private runDmlWithCdc(op: DmlOp, opType: string, table: string, sql: string, params: unknown[]): {
    before: Record<string, unknown>[] | null;
    after: Record<string, unknown>[] | null;
    primaryKey: Record<string, unknown>[] | null;
    affectedRows: number;
  } {
    const columns = getTableColumns(this.db, table);
    if (columns.length === 0) {
      throw new Error(`Guard: target table does not exist or has no columns: ${table}`);
    }
    const pkColumns = columns
      .filter((column) => column.pk > 0)
      .sort((a, b) => a.pk - b.pk)
      .map((column) => column.name);

    const beforeExpr = jsonObjectExpression("OLD", columns);
    const afterExpr = jsonObjectExpression("NEW", columns);
    const qTable = quoteIdent(table);
    const tempSuffix = ulid().toLowerCase();
    const tempTable = quoteIdent(`_adiabatic_cdc_${tempSuffix}`);
    const triggerPrefix = `_adiabatic_cdc_${tempSuffix}`;

    this.db.run("BEGIN IMMEDIATE");
    try {
      this.db.run(`CREATE TEMP TABLE ${tempTable} (op TEXT NOT NULL, before_json TEXT, after_json TEXT)`);
      this.db.run(
        `CREATE TEMP TRIGGER ${quoteIdent(`${triggerPrefix}_insert`)}
         AFTER INSERT ON ${qTable}
         BEGIN
           INSERT INTO ${tempTable} (op, before_json, after_json)
           VALUES ('insert', NULL, ${afterExpr});
         END`
      );
      this.db.run(
        `CREATE TEMP TRIGGER ${quoteIdent(`${triggerPrefix}_update`)}
         AFTER UPDATE ON ${qTable}
         BEGIN
           INSERT INTO ${tempTable} (op, before_json, after_json)
           VALUES ('update', ${beforeExpr}, ${afterExpr});
         END`
      );
      this.db.run(
        `CREATE TEMP TRIGGER ${quoteIdent(`${triggerPrefix}_delete`)}
         AFTER DELETE ON ${qTable}
         BEGIN
           INSERT INTO ${tempTable} (op, before_json, after_json)
           VALUES ('delete', ${beforeExpr}, NULL);
         END`
      );

      const stmt = this.db.prepare(sql);
      if (params.length > 0) {
        stmt.run(...params);
      } else {
        stmt.run();
      }

      const rows = this.db.prepare(`SELECT op, before_json, after_json FROM ${tempTable}`).all() as Array<{
        op: string;
        before_json: string | null;
        after_json: string | null;
      }>;
      const beforeRows = rows
        .map((row) => row.before_json ? JSON.parse(row.before_json) as Record<string, unknown> : null)
        .filter(isRecord);
      const afterRows = rows
        .map((row) => row.after_json ? JSON.parse(row.after_json) as Record<string, unknown> : null)
        .filter(isRecord);
      const pkSource = op === "delete" ? beforeRows : afterRows;
      const primaryKey = pkColumns.length > 0
        ? pkSource.map((row) => Object.fromEntries(pkColumns.map((column) => [column, row[column]])))
        : null;

      const cdc = {
        before: op === "insert" ? null : beforeRows,
        after: op === "delete" ? null : afterRows,
        primaryKey,
        affectedRows: rows.length,
      };
      this.logD0(opType, {
        op,
        table,
        primary_key: cdc.primaryKey,
        before: cdc.before,
        after: cdc.after,
        affected_rows: cdc.affectedRows,
        sql: sql.slice(0, 500),
        params,
        schema_version: D0_SCHEMA_VERSION,
      });
      this.db.run("COMMIT");
      return cdc;
    } catch (err) {
      try { this.db.run("ROLLBACK"); } catch {}
      throw err;
    } finally {
      try { this.db.run(`DROP TRIGGER IF EXISTS ${quoteIdent(`${triggerPrefix}_insert`)}`); } catch {}
      try { this.db.run(`DROP TRIGGER IF EXISTS ${quoteIdent(`${triggerPrefix}_update`)}`); } catch {}
      try { this.db.run(`DROP TRIGGER IF EXISTS ${quoteIdent(`${triggerPrefix}_delete`)}`); } catch {}
      try { this.db.run(`DROP TABLE IF EXISTS ${tempTable}`); } catch {}
    }
  }

  // -- Internal: D0 auto-log --

  private logD0(type: string, payload: Record<string, unknown>): void {
    const id = ulid();
    const now = Date.now();
    const stmt = this.stmts.insertEvent ??= this.db.prepare(
      `INSERT INTO events (id, schema_version, source, type, external_id, started_at, ended_at, payload)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    );
    stmt.run(id, D0_SCHEMA_VERSION, this.source, type, null, now, null, JSON.stringify(payload));
  }

  private runReadOnly<T>(fn: () => T): T {
    const existing = this.db.prepare("PRAGMA query_only").get() as { query_only: number } | null;
    const wasQueryOnly = existing?.query_only === 1;
    this.db.run("PRAGMA query_only = ON");
    try {
      return fn();
    } finally {
      if (!wasQueryOnly) {
        this.db.run("PRAGMA query_only = OFF");
      }
    }
  }
}

interface TableColumn {
  name: string;
  type: string;
  notnull: number;
  dflt_value: unknown;
  pk: number;
}

interface SchemaSnapshot {
  tables: Array<{ name: string; sql: string; columns: TableColumn[] }>;
  indexes: Array<{ name: string; table: string; sql: string | null }>;
}

function getTableColumns(db: Database, table: string): TableColumn[] {
  return db.prepare(`PRAGMA table_info(${quoteIdent(table)})`).all() as TableColumn[];
}

function snapshotSchema(db: Database): SchemaSnapshot {
  const tables = db.prepare(
    `SELECT name, sql FROM sqlite_master
     WHERE type = 'table'
       AND name NOT LIKE 'sqlite_%'
       AND name NOT IN ('events', 'docs')
     ORDER BY name`
  ).all() as Array<{ name: string; sql: string }>;

  const indexes = db.prepare(
    `SELECT name, tbl_name as table_name, sql FROM sqlite_master
     WHERE type = 'index'
       AND name NOT LIKE 'sqlite_%'
       AND tbl_name NOT IN ('events', 'docs')
     ORDER BY name`
  ).all() as Array<{ name: string; table_name: string; sql: string | null }>;

  return {
    tables: tables.map((table) => ({
      name: table.name,
      sql: table.sql,
      columns: getTableColumns(db, table.name),
    })),
    indexes: indexes.map((index) => ({
      name: index.name,
      table: index.table_name,
      sql: index.sql,
    })),
  };
}

// Extract table name from SQL (simple parser, good enough for allowed DML/DDL)
function extractTable(sql: string, keyword: string): string | null {
  const regex = new RegExp(`${keyword}\\s+(?:IF\\s+(?:NOT\\s+)?EXISTS\\s+)?["'\`]?(\\w+)["'\`]?`, "i");
  const match = sql.match(regex);
  return match?.[1] ?? null;
}

function isSystemTable(table: string): boolean {
  const normalized = table.toLowerCase();
  return SYSTEM_TABLES.has(normalized) || SYSTEM_TABLE_PREFIXES.some((prefix) => normalized.startsWith(prefix));
}

function isRecord(value: Record<string, unknown> | null): value is Record<string, unknown> {
  return value !== null;
}

function quoteIdent(ident: string): string {
  return `"${ident.replace(/"/g, '""')}"`;
}

function jsonObjectExpression(prefix: "OLD" | "NEW", columns: TableColumn[]): string {
  const parts = columns.flatMap((column) => [
    `'${column.name.replace(/'/g, "''")}'`,
    `${prefix}.${quoteIdent(column.name)}`,
  ]);
  return `json_object(${parts.join(", ")})`;
}

function normalizeStatements(ddl: string | string[]): string[] {
  const raw = Array.isArray(ddl) ? ddl : splitSqlStatements(ddl);
  return raw.map((statement) => statement.trim()).filter(Boolean);
}

function dryRunDdl(db: Database, statements: string[]): void {
  db.run("BEGIN IMMEDIATE");
  try {
    for (const statement of statements) {
      db.run(statement);
    }
    db.run("ROLLBACK");
  } catch (err) {
    try { db.run("ROLLBACK"); } catch {}
    throw err;
  }
}

function splitSqlStatements(sql: string): string[] {
  const statements: string[] = [];
  let start = 0;
  let quote: "'" | '"' | "`" | null = null;
  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i];
    if (quote) {
      if (ch === quote) {
        if ((quote === "'" || quote === '"') && sql[i + 1] === quote) {
          i++;
        } else {
          quote = null;
        }
      }
      continue;
    }
    if (ch === "'" || ch === '"' || ch === "`") {
      quote = ch;
      continue;
    }
    if (ch === ";") {
      statements.push(sql.slice(start, i));
      start = i + 1;
    }
  }
  statements.push(sql.slice(start));
  return statements;
}

function validateDdl(db: Database, kind: SchemaOp, statement: string): void {
  const normalized = statement.trim().replace(/\s+/g, " ").toUpperCase();
  const targets = extractDdlTargets(db, statement);
  const systemTarget = targets.find(isSystemTable);
  if (systemTarget) {
    throw new Error(`Guard: schema lifecycle cannot modify system table: ${systemTarget}`);
  }

  const allowed = kind === "promote"
    ? (
      normalized.startsWith("CREATE TABLE ") ||
      normalized.startsWith("CREATE TABLE IF NOT EXISTS ") ||
      normalized.startsWith("CREATE INDEX ") ||
      normalized.startsWith("CREATE UNIQUE INDEX ") ||
      normalized.startsWith("CREATE INDEX IF NOT EXISTS ") ||
      normalized.startsWith("CREATE UNIQUE INDEX IF NOT EXISTS ") ||
      /^ALTER TABLE\s+.+\s+ADD COLUMN\s+/i.test(statement)
    )
    : (
      normalized.startsWith("DROP TABLE ") ||
      normalized.startsWith("DROP TABLE IF EXISTS ") ||
      normalized.startsWith("DROP INDEX ") ||
      normalized.startsWith("DROP INDEX IF EXISTS ")
    );
  if (!allowed) {
    throw new Error(`Guard: ${kind} DDL is not allowed: ${statement.slice(0, 80)}`);
  }
}

function extractDdlTargets(db: Database, statement: string): string[] {
  const targets = new Set<string>();
  const tableTarget = extractTable(statement, "TABLE");
  if (tableTarget) targets.add(tableTarget);
  const indexTarget = extractTable(statement, "INDEX");
  if (indexTarget) {
    targets.add(indexTarget);
    const row = db.prepare("SELECT tbl_name FROM sqlite_master WHERE type = 'index' AND name = ?")
      .get(indexTarget) as { tbl_name?: string } | null;
    if (row?.tbl_name) targets.add(row.tbl_name);
  }
  const createIndexTable = statement.match(/\bON\s+["'`]?([\w]+)["'`]?\s*\(/i)?.[1];
  if (createIndexTable) targets.add(createIndexTable);
  return [...targets];
}

function containsStatementSeparator(sql: string): boolean {
  let quote: "'" | '"' | "`" | null = null;
  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i];
    if (quote) {
      if (ch === quote) {
        if ((quote === "'" || quote === '"') && sql[i + 1] === quote) {
          i++;
        } else {
          quote = null;
        }
      }
      continue;
    }
    if (ch === "'" || ch === '"' || ch === "`") {
      quote = ch;
      continue;
    }
    if (ch === ";") return true;
  }
  return false;
}

// The system event namespaces (see D0 System Event Catalog) are audit
// records; only system code may write them explicitly. Internal auto-logs
// (logD0) do not pass through writeEvent and are unaffected.
// `app.created`/`app.archived` are app-lifecycle composition acts written by
// the core; `app.commit` is intentionally NOT reserved — the app-commits
// connector emits it from a connector source.
const RESERVED_EVENT_TYPE_PREFIXES = [
  "connector.",
  "d1.",
  "d2.",
  "ddl.",
  "app.created",
  "app.archived",
];

function assertEventTypeAllowed(source: string, type: string): void {
  if (source.startsWith("system:")) return;
  if (RESERVED_EVENT_TYPE_PREFIXES.some((prefix) => type.startsWith(prefix))) {
    throw new Error(`Guard: event type "${type}" is in a system-reserved namespace`);
  }
}

function validateEventInput(event: EventInput): void {
  if (!event.type || event.type.trim() !== event.type) {
    throw new Error("Guard: event requires a type");
  }
  if (!Number.isFinite(event.startedAt)) {
    throw new Error("Guard: event requires a finite startedAt timestamp");
  }
  if (event.endedAt !== undefined && !Number.isFinite(event.endedAt)) {
    throw new Error("Guard: event endedAt must be finite when provided");
  }
  assertJsonValue(event.payload, "Guard event payload");
}

function validateSingleStatement(sql: string, method: string): void {
  if (!sql) {
    throw new Error(`Guard: ${method} requires SQL`);
  }
  if (containsStatementSeparator(sql)) {
    throw new Error(`Guard: ${method} accepts one read-only statement without semicolons`);
  }
}
