import { join } from "path";
import { mkdir } from "fs/promises";
import { openDB } from "./db";
import { Guard } from "./guard";
import { WorkingTree } from "./working-tree";
import { loadApps } from "./app-loader";
import { renderMDX } from "./renderer";
import { bundleApp } from "./app-bundler-server";
import { readdir, readFile } from "fs/promises";

// Adiabatic OS — HTTP server entry point
// All routes go through here. Guard is the only write path.

const workspacePath = process.argv[2] || process.cwd();
const pagesDir = join(workspacePath, "pages");
const appsDir = join(workspacePath, "apps");
const adiabaticDir = join(workspacePath, ".adiabatic");

// Ensure .adiabatic/ exists
await mkdir(adiabaticDir, { recursive: true });

// Boot
const { db, close: closeDB } = openDB(workspacePath);
const guard = new Guard({ db, source: "system:server" });
const registry = await loadApps(appsDir);
const workingTree = new WorkingTree({ guard, pagesDir });
await workingTree.start();

console.log(`[adiabatic] Workspace: ${workspacePath}`);
console.log(`[adiabatic] Apps loaded: ${[...registry.apps.keys()].join(", ") || "(none)"}`);

// CORS + JSON helpers
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, X-App-Id",
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

// Routes
const server = Bun.serve({
  port: 3000,
  async fetch(req) {
    const url = new URL(req.url);
    const path = url.pathname;
    const method = req.method;

    // CORS preflight
    if (method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS });
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

      // -- App Bundle (serve bundled app code for browser) --
      const bundleMatch = path.match(/^\/api\/apps\/([^/]+)\/bundle$/);
      if (bundleMatch && method === "GET") {
        const appId = decodeURIComponent(bundleMatch[1]);
        const app = registry.apps.get(appId);
        if (!app) return json({ error: "app not found" }, 404);
        try {
          const code = await bundleApp(app.entryPoint, app.dir);
          return new Response(code, {
            headers: {
              "Content-Type": "application/javascript",
              "Access-Control-Allow-Origin": "*",
            },
          });
        } catch (err: unknown) {
          const message = err instanceof Error ? err.message : String(err);
          return json({ error: `Bundle failed: ${message}` }, 500);
        }
      }

      // -- Render (MDX → compiled JS) --
      if (path === "/api/render" && method === "POST") {
        const body = await readBody<{ mdx: string }>(req);
        const result = await renderMDX(body.mdx);
        if (result.error) return json({ error: result.error }, 400);
        return json({ code: result.code });
      }

      return json({ error: "not found" }, 404);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[adiabatic] Error: ${message}`);
      return json({ error: message }, 500);
    }
  },
});

console.log(`[adiabatic] Server running on http://localhost:${server.port}`);

// Graceful shutdown
process.on("SIGINT", () => {
  console.log("\n[adiabatic] Shutting down...");
  workingTree.stop();
  closeDB();
  process.exit(0);
});
