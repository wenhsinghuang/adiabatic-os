import { join } from "path";
import { mkdir, writeFile } from "fs/promises";
import { openDB } from "./db";
import { Guard } from "./guard";
import { WorkingTree } from "./working-tree";
import { loadApps } from "./app-loader";
import { renderMDX } from "./renderer";
import { ensureClaudeMd } from "./claude-md";
import { readdir, readFile, stat } from "fs/promises";
import { dirname } from "path";
import { ulid } from "./utils/ulid";

// Adiabatic OS — HTTP server entry point
// All routes go through here. Guard is the only write path.

const workspacePath = process.argv[2] || process.cwd();
const pagesDir = join(workspacePath, "pages");
const appsDir = join(workspacePath, "apps");
const adiabaticDir = join(workspacePath, ".adiabatic");

// Ensure .adiabatic/ exists
await mkdir(adiabaticDir, { recursive: true });

// Ensure CLAUDE.md with system section markers
await ensureClaudeMd(workspacePath);

// Boot
const { db, close: closeDB } = openDB(workspacePath);
const guard = new Guard({ db, source: "system:server" });
let registry = await loadApps(appsDir);
const workingTree = new WorkingTree({ guard, pagesDir });
await workingTree.start();

// SSE: push doc change notifications to connected shell clients
const sseClients = new Set<ReadableStreamDefaultController>();
guard.docChangeSubscribers.push((id) => {
  const msg = `data: ${JSON.stringify({ id })}\n\n`;
  for (const c of sseClients) {
    try { c.enqueue(new TextEncoder().encode(msg)); } catch { sseClients.delete(c); }
  }
});

console.log(`[adiabatic] Workspace: ${workspacePath}`);
console.log(`[adiabatic] Apps loaded: ${[...registry.apps.keys()].join(", ") || "(none)"}`);

// CORS + cross-origin isolation (required for SharedArrayBuffer / WebContainer)
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, X-App-Id",
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Embedder-Policy": "credentialless",
};

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...CORS },
  });
}

async function readBody<T>(req: Request): Promise<T> {
  return (await req.json()) as T;
}

// Track active terminal subprocesses for cleanup
const terminalProcs = new Set<import("bun").Subprocess>();
const ptyHelperPath = join(dirname(new URL(import.meta.url).pathname), "pty-helper.cjs");

// Terminal I/O logger — captures input/output as D0 events
const INPUT_BATCH_MS = 300;
const OUTPUT_BATCH_MS = 2000;
const OUTPUT_MAX_BYTES = 64 * 1024;

class TerminalLogger {
  sessionId: string;
  private inputBuf = "";
  private inputTimer: ReturnType<typeof setTimeout> | null = null;
  private outputBuf = "";
  private outputTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private guard: Guard) {
    this.sessionId = ulid();
  }

  open(): void {
    this.guard.writeEvent({
      source: "system:terminal",
      type: "terminal.open",
      startedAt: Date.now(),
      payload: { sessionId: this.sessionId },
    });
  }

  close(): void {
    this.flushInput();
    this.flushOutput();
    this.guard.writeEvent({
      source: "system:terminal",
      type: "terminal.close",
      startedAt: Date.now(),
      payload: { sessionId: this.sessionId },
    });
  }

  appendInput(data: string): void {
    this.inputBuf += data;
    if (!this.inputTimer) {
      this.inputTimer = setTimeout(() => this.flushInput(), INPUT_BATCH_MS);
    }
  }

  appendOutput(data: string): void {
    this.outputBuf += data;
    if (Buffer.byteLength(this.outputBuf, "utf8") >= OUTPUT_MAX_BYTES) {
      this.flushOutput();
    } else if (!this.outputTimer) {
      this.outputTimer = setTimeout(() => this.flushOutput(), OUTPUT_BATCH_MS);
    }
  }

  private flushInput(): void {
    if (this.inputTimer) { clearTimeout(this.inputTimer); this.inputTimer = null; }
    if (!this.inputBuf) return;
    const data = this.inputBuf;
    this.inputBuf = "";
    this.guard.writeEvent({
      source: "system:terminal",
      type: "terminal.input",
      startedAt: Date.now(),
      payload: { sessionId: this.sessionId, data },
    });
  }

  private flushOutput(): void {
    if (this.outputTimer) { clearTimeout(this.outputTimer); this.outputTimer = null; }
    if (!this.outputBuf) return;
    const data = this.outputBuf;
    this.outputBuf = "";
    this.guard.writeEvent({
      source: "system:terminal",
      type: "terminal.output",
      startedAt: Date.now(),
      payload: { sessionId: this.sessionId, data },
    });
  }
}

// Routes
const server = Bun.serve({
  port: Number(process.env.PORT) || 3000,
  idleTimeout: 255, // max — SSE connections need long-lived responses
  async fetch(req, server) {
    const url = new URL(req.url);
    const path = url.pathname;
    const method = req.method;

    // CORS preflight
    if (method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS });
    }

    // -- Terminal WebSocket upgrade --
    if (path === "/api/terminal") {
      const upgraded = server.upgrade(req, { data: { cwd: workspacePath } });
      if (!upgraded) {
        return new Response("WebSocket upgrade failed", { status: 400, headers: CORS });
      }
      return undefined as unknown as Response;
    }

    // -- SSE: doc change stream --
    if (path === "/api/docs/events" && method === "GET") {
      let ctrl: ReadableStreamDefaultController;
      const stream = new ReadableStream({
        start(controller) {
          ctrl = controller;
          sseClients.add(controller);
          controller.enqueue(new TextEncoder().encode(": connected\n\n"));
        },
        cancel() {
          sseClients.delete(ctrl);
        },
      });
      return new Response(stream, {
        headers: {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
          ...CORS,
        },
      });
    }

    try {
      // -- Docs --
      if (path === "/api/docs" && method === "POST") {
        const body = await readBody<{ id: string; content: string; metadata?: Record<string, unknown> }>(req);
        guard.writeDoc(body.id, body.content, body.metadata);
        return json({ ok: true, id: body.id });
      }

      if (path.startsWith("/api/docs/") && method === "GET") {
        const docId = decodeURIComponent(path.slice("/api/docs/".length));
        const doc = guard.queryOne("SELECT * FROM docs WHERE id = ?", [docId]);
        if (!doc) return json({ error: "not found" }, 404);
        return json(doc);
      }

      if (path.startsWith("/api/docs/") && method === "DELETE") {
        const docId = decodeURIComponent(path.slice("/api/docs/".length));
        const deleted = guard.deleteDoc(docId);
        if (!deleted) return json({ error: "not found" }, 404);
        return json({ ok: true });
      }

      // -- Events --
      if (path === "/api/events" && method === "POST") {
        const body = await readBody<{
          source: string; type: string; startedAt: number;
          endedAt?: number; externalId?: string; payload: Record<string, unknown>;
        }>(req);
        const id = guard.writeEvent(body);
        return json({ ok: true, id });
      }

      // -- Query (read-only SQL) --
      if (path === "/api/query" && method === "POST") {
        const body = await readBody<{ sql: string; params?: unknown[] }>(req);
        const rows = guard.query(body.sql, body.params);
        return json({ rows });
      }

      // -- Write (D2 DML + auto D0 log) --
      if (path === "/api/write" && method === "POST") {
        const body = await readBody<{ sql: string; params?: unknown[] }>(req);
        guard.write(body.sql, body.params);
        return json({ ok: true });
      }

      // -- Apps --
      if (path === "/api/apps" && method === "GET") {
        const apps = [...registry.apps.values()].map((a) => ({
          id: a.manifest.id,
          name: a.manifest.name,
          permissions: a.manifest.permissions,
          components: a.manifest.components,
          entryPoint: a.entryPoint,
        }));
        return json({ apps });
      }

      // -- App Source (serve raw source files for WebContainer) --
      const sourceMatch = path.match(/^\/api\/apps\/([^/]+)\/source$/);
      if (sourceMatch && method === "GET") {
        const appId = decodeURIComponent(sourceMatch[1]);
        const app = registry.apps.get(appId);
        if (!app) return json({ error: "app not found" }, 404);
        try {
          const files: Record<string, string> = {};
          const entries = await readdir(app.dir);
          for (const entry of entries) {
            const content = await readFile(join(app.dir, entry), "utf8");
            files[entry] = content;
          }
          return json(files);
        } catch (err: unknown) {
          const message = err instanceof Error ? err.message : String(err);
          return json({ error: message }, 500);
        }
      }

      // -- Create App --
      if (path === "/api/apps" && method === "POST") {
        const body = await readBody<{ id: string; name: string }>(req);
        const id = body.id;
        const name = body.name || id;

        // Validate id: lowercase, alphanumeric + hyphens
        if (!/^[a-z0-9][a-z0-9-]*$/.test(id)) {
          return json({ error: "Invalid app id. Use lowercase alphanumeric + hyphens." }, 400);
        }

        const appDir = join(appsDir, id);
        await mkdir(appDir, { recursive: true });

        const manifest = {
          id,
          name,
          permissions: { write: [] },
          components: [],
        };
        await writeFile(join(appDir, "manifest.json"), JSON.stringify(manifest, null, 2));
        await writeFile(
          join(appDir, "index.tsx"),
          `// ${name} — app entry point\nimport React from "react";\n\nexport default function ${name.replace(/[^a-zA-Z0-9]/g, "")}() {\n  return <div>${name}</div>;\n}\n`,
        );

        // Reload registry
        registry = await loadApps(appsDir);
        return json({ ok: true, id });
      }

      // -- Save App File --
      const fileMatch = path.match(/^\/api\/apps\/([^/]+)\/files\/(.+)$/);
      if (fileMatch && method === "PUT") {
        const appId = decodeURIComponent(fileMatch[1]);
        const filename = decodeURIComponent(fileMatch[2]);

        // Path traversal protection
        if (filename.includes("..") || filename.includes("/")) {
          return json({ error: "Invalid filename" }, 400);
        }

        const app = registry.apps.get(appId);
        if (!app) return json({ error: "app not found" }, 404);

        const body = await readBody<{ content: string }>(req);
        await writeFile(join(app.dir, filename), body.content);

        // Reload registry if manifest was modified
        if (filename === "manifest.json") {
          registry = await loadApps(appsDir);
        }

        return json({ ok: true });
      }

      // -- Render (MDX → compiled JS) --
      if (path === "/api/render" && method === "POST") {
        const body = await readBody<{ mdx: string }>(req);
        const result = await renderMDX(body.mdx);
        if (result.error) return json({ error: result.error }, 400);
        return json({ code: result.code });
      }

      // -- Shell (static SPA) --
      const shellDir = process.env.SHELL_DIST;
      if (shellDir) {
        // Try exact file first, then fall back to index.html (SPA routing)
        const filePath = join(shellDir, path === "/" ? "index.html" : path);
        try {
          const info = await stat(filePath);
          if (info.isFile()) return new Response(Bun.file(filePath), { headers: CORS });
        } catch {}
        // SPA fallback: serve index.html for non-file routes
        try {
          const indexPath = join(shellDir, "index.html");
          await stat(indexPath);
          return new Response(Bun.file(indexPath), { headers: CORS });
        } catch {}
      }

      return json({ error: "not found" }, 404);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[adiabatic] Error: ${message}`);
      return json({ error: message }, 500);
    }
  },
  websocket: {
    open(ws) {
      const { cwd } = ws.data as { cwd: string };

      // Terminal I/O logger
      const logger = new TerminalLogger(guard);
      (ws as any)._logger = logger;
      logger.open();

      // Spawn Node.js helper that manages the PTY
      // (bun can't load node-pty native addon directly)
      const proc = Bun.spawn(["node", ptyHelperPath, cwd], {
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
        env: {
          ...process.env,
          TERM: "xterm-256color",
          LANG: "en_US.UTF-8",
        },
      });

      terminalProcs.add(proc);
      (ws as any)._proc = proc;

      const decoder = new TextDecoder();

      // PTY stdout → WebSocket + log output
      (async () => {
        const reader = proc.stdout.getReader();
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            ws.send(value);
            logger.appendOutput(decoder.decode(value, { stream: true }));
          }
        } catch {}
        terminalProcs.delete(proc);
        try { ws.close(); } catch {}
      })();

      // PTY stderr → WebSocket + log output
      (async () => {
        const reader = proc.stderr.getReader();
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            ws.send(value);
            logger.appendOutput(decoder.decode(value, { stream: true }));
          }
        } catch {}
      })();
    },
    message(ws, message) {
      const proc = (ws as any)._proc as import("bun").Subprocess | undefined;
      if (!proc?.stdin) return;

      // Forward data (including \x01 resize messages) to the Node helper
      const data = typeof message === "string" ? message : new TextDecoder().decode(message);
      proc.stdin.write(data);
      proc.stdin.flush();

      // Log input (skip \x01 resize control messages)
      if (data.length > 0 && data.charCodeAt(0) !== 0x01) {
        const logger = (ws as any)._logger as TerminalLogger | undefined;
        logger?.appendInput(data);
      }
    },
    close(ws) {
      // Flush and log terminal close
      const logger = (ws as any)._logger as TerminalLogger | undefined;
      logger?.close();

      const proc = (ws as any)._proc as import("bun").Subprocess | undefined;
      if (proc) {
        terminalProcs.delete(proc);
        try { proc.kill(); } catch {}
      }
    },
  },
});

console.log(`[adiabatic] Server running on http://localhost:${server.port}`);

// Graceful shutdown
process.on("SIGINT", () => {
  console.log("\n[adiabatic] Shutting down...");
  for (const proc of terminalProcs) {
    try { proc.kill(); } catch {}
  }
  terminalProcs.clear();
  workingTree.stop();
  closeDB();
  process.exit(0);
});
