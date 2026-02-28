import { Guard } from "./guard";
import type { AppRegistry } from "./app-loader";
import type { Database } from "bun:sqlite";

// App Sandbox — runs app backend code in isolated Bun Workers.
// Apps communicate with Guard exclusively through postMessage (system.* bridge).
// The main process knows which Worker belongs to which app → source cannot be forged.

export interface SandboxMessage {
  id: string;
  method: "query" | "write" | "writeDoc" | "deleteDoc" | "writeEvent";
  args: unknown[];
}

export interface SandboxResponse {
  id: string;
  result?: unknown;
  error?: string;
}

export interface AppSandbox {
  appId: string;
  worker: Worker;
  guard: Guard; // scoped guard with app source
  terminate(): void;
}

export class SandboxManager {
  private db: Database;
  private registry: AppRegistry;
  private sandboxes = new Map<string, AppSandbox>();

  constructor(db: Database, registry: AppRegistry) {
    this.db = db;
    this.registry = registry;
  }

  // Spawn a Worker for an app
  async spawn(appId: string): Promise<AppSandbox> {
    const app = this.registry.apps.get(appId);
    if (!app) throw new Error(`App not found: ${appId}`);

    // Each app gets its own Guard with source = "app:{appId}" — unforgeable
    const guard = new Guard({ db: this.db, source: `app:${appId}` });

    const worker = new Worker(app.entryPoint, { type: "module" });

    worker.onmessage = (event: MessageEvent<SandboxMessage>) => {
      this.handleMessage(appId, guard, event.data, worker);
    };

    worker.onerror = (event) => {
      console.error(`[sandbox] App ${appId} error:`, event.message);
    };

    const sandbox: AppSandbox = { appId, worker, guard, terminate: () => worker.terminate() };
    this.sandboxes.set(appId, sandbox);
    return sandbox;
  }

  private handleMessage(appId: string, guard: Guard, msg: SandboxMessage, worker: Worker): void {
    let result: unknown;
    let error: string | undefined;

    try {
      switch (msg.method) {
        case "query": {
          const [sql, params] = msg.args as [string, unknown[]?];
          result = guard.query(sql, params);
          break;
        }
        case "write": {
          const [sql, params] = msg.args as [string, unknown[]?];
          const table = extractTableFromSql(sql);
          if (table && !this.registry.hasWritePermission(appId, table)) {
            throw new Error(`Permission denied: app "${appId}" cannot write to table "${table}"`);
          }
          guard.write(sql, params as unknown[]);
          break;
        }
        case "writeDoc": {
          const [id, content, meta] = msg.args as [string, string, Record<string, unknown>?];
          guard.writeDoc(id, content, meta);
          break;
        }
        case "deleteDoc": {
          const [id] = msg.args as [string];
          result = guard.deleteDoc(id);
          break;
        }
        case "writeEvent": {
          const [event] = msg.args as [Parameters<Guard["writeEvent"]>[0]];
          event.source = `app:${appId}`; // enforce source
          result = guard.writeEvent(event);
          break;
        }
        default:
          throw new Error(`Unknown method: ${msg.method}`);
      }
    } catch (err: unknown) {
      error = err instanceof Error ? err.message : String(err);
    }

    const response: SandboxResponse = { id: msg.id, result, error };
    worker.postMessage(response);
  }

  terminateAll(): void {
    for (const sandbox of this.sandboxes.values()) {
      sandbox.terminate();
    }
    this.sandboxes.clear();
  }
}

function extractTableFromSql(sql: string): string | null {
  const normalized = sql.trim().toUpperCase();
  let keyword: string;
  if (normalized.startsWith("INSERT")) keyword = "INTO";
  else if (normalized.startsWith("UPDATE")) keyword = "UPDATE";
  else if (normalized.startsWith("DELETE")) keyword = "FROM";
  else if (normalized.startsWith("CREATE")) keyword = "TABLE";
  else if (normalized.startsWith("DROP")) keyword = "TABLE";
  else return null;

  const regex = new RegExp(`${keyword}\\s+(?:IF\\s+(?:NOT\\s+)?EXISTS\\s+)?["'\`]?(\\w+)["'\`]?`, "i");
  const match = sql.match(regex);
  return match?.[1] ?? null;
}
