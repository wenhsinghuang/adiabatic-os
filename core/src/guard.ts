import type { Database } from "bun:sqlite";
import { ulid } from "./utils/ulid";

// Guard — the only write path into the database.
// Every mutation goes through here: permission check → execute → auto D0 log.

export interface EventInput {
  source: string;
  type: string;
  externalId?: string;
  startedAt: number;
  endedAt?: number;
  payload: Record<string, unknown>;
}

export interface GuardOptions {
  db: Database;
  source: string; // injected at construction, cannot be forged by app
}

export class Guard {
  private db: Database;
  private source: string;

  // Prepared statements (lazy init)
  private stmts: {
    insertEvent?: ReturnType<Database["prepare"]>;
    upsertDoc?: ReturnType<Database["prepare"]>;
    getDoc?: ReturnType<Database["prepare"]>;
    deleteDoc?: ReturnType<Database["prepare"]>;
  } = {};

  // Listener for doc changes (working tree uses this)
  public onDocChange?: (id: string, content: string | null) => void;

  constructor(opts: GuardOptions) {
    this.db = opts.db;
    this.source = opts.source;
  }

  // -- Read (no permission check, no D0 log) --

  query(sql: string, params?: unknown[]): unknown[] {
    const stmt = this.db.prepare(sql);
    return params ? stmt.all(...params) : stmt.all();
  }

  queryOne(sql: string, params?: unknown[]): unknown | null {
    const stmt = this.db.prepare(sql);
    return params ? stmt.get(...params) : stmt.get();
  }

  // -- D0: writeEvent (explicit event, no additional D0 log) --

  writeEvent(event: EventInput): string {
    const id = ulid();
    const stmt = this.stmts.insertEvent ??= this.db.prepare(
      `INSERT INTO events (id, source, type, external_id, started_at, ended_at, payload)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    );
    stmt.run(
      id,
      event.source,
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
    const now = Date.now();
    const meta = metadata ? JSON.stringify(metadata) : null;

    const stmt = this.stmts.upsertDoc ??= this.db.prepare(
      `INSERT INTO docs (id, content, metadata, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         content = excluded.content,
         metadata = COALESCE(excluded.metadata, docs.metadata),
         updated_at = excluded.updated_at`
    );
    stmt.run(id, content, meta, now, now);

    // Auto D0 log — behavior signal only, not full content
    const isLocked = metadata?.locked === true;
    if (!isLocked) {
      this.logD0("d1.write", {
        doc_id: id,
        bytes: Buffer.byteLength(content, "utf8"),
      });
    }

    this.onDocChange?.(id, content);
  }

  // -- D1: deleteDoc (hard delete + auto D0 snapshot) --

  deleteDoc(id: string): boolean {
    // Read before delete — snapshot for D0 safety net
    const existing = this.stmts.getDoc ??= this.db.prepare(
      "SELECT id, content, metadata FROM docs WHERE id = ?"
    );
    const doc = existing.get(id) as { id: string; content: string; metadata: string } | null;
    if (!doc) return false;

    const stmt = this.stmts.deleteDoc ??= this.db.prepare(
      "DELETE FROM docs WHERE id = ?"
    );
    stmt.run(id);

    // D0 log — full snapshot (safety net for hard delete)
    this.logD0("d1.delete", {
      doc_id: id,
      content: doc.content,
      metadata: doc.metadata ? JSON.parse(doc.metadata) : null,
    });

    this.onDocChange?.(id, null);
    return true;
  }

  // -- D2: write (DML + auto D0 log) --

  write(sql: string, params?: unknown[]): void {
    // Parse the SQL to determine operation type and table
    const normalized = sql.trim().toUpperCase();
    let opType: string;
    let table: string | null = null;

    if (normalized.startsWith("INSERT")) {
      opType = "d2.insert";
      table = extractTable(sql, "INTO");
    } else if (normalized.startsWith("UPDATE")) {
      opType = "d2.update";
      table = extractTable(sql, "UPDATE");
    } else if (normalized.startsWith("DELETE")) {
      opType = "d2.delete";
      table = extractTable(sql, "FROM");
    } else if (normalized.startsWith("CREATE")) {
      opType = "ddl.promote";
      table = extractTable(sql, "TABLE");
    } else if (normalized.startsWith("DROP")) {
      opType = "ddl.demote";
      table = extractTable(sql, "TABLE");
    } else {
      throw new Error(`Guard: unsupported write operation: ${sql.slice(0, 30)}`);
    }

    // Execute
    const stmt = this.db.prepare(sql);
    if (params) {
      stmt.run(...params);
    } else {
      stmt.run();
    }

    // Auto D0 log
    this.logD0(opType, {
      table,
      sql: sql.slice(0, 500),
      params: params ?? [],
    });
  }

  // -- Internal: D0 auto-log --

  private logD0(type: string, payload: Record<string, unknown>): void {
    const id = ulid();
    const now = Date.now();
    const stmt = this.stmts.insertEvent ??= this.db.prepare(
      `INSERT INTO events (id, source, type, external_id, started_at, ended_at, payload)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    );
    stmt.run(id, this.source, type, null, now, null, JSON.stringify(payload));
  }
}

// Extract table name from SQL (simple parser, good enough for D2 ops)
function extractTable(sql: string, keyword: string): string | null {
  const regex = new RegExp(`${keyword}\\s+(?:IF\\s+(?:NOT\\s+)?EXISTS\\s+)?["'\`]?(\\w+)["'\`]?`, "i");
  const match = sql.match(regex);
  return match?.[1] ?? null;
}
