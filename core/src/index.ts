import { dirname, join, relative, resolve } from "path";
import { fileURLToPath } from "url";
import { mkdir, readdir, readFile, stat, writeFile } from "fs/promises";
import { openDatabases } from "./db";
import { Guard } from "./guard";
import type { SchemaOp } from "./guard";
import { WorkingTree } from "./working-tree";
import { loadApps } from "./app-loader";
import { ensureClaudeMd } from "./claude-md";
import {
  ConnectorScheduler,
  ConnectorSupervisor,
  currentConnectorPlatform,
  installConnectorFromSource,
  isPlatformSupported,
  listAvailableBuiltIns,
  registerWorkspaceConnectors,
  removeInstalledConnector,
} from "./connectors";
import { ulid } from "./utils/ulid";
import { SettingsStore } from "./settings";
import {
  APP_ID_HEADER,
  BRIDGE_TOKEN_HEADER,
  authenticateRequest,
  requireSecret,
  type AuthContext,
  type AuthSecrets,
} from "./auth";
import type { JsonValue } from "./json";

// Adiabatic OS — HTTP server entry point
// All routes go through here. Guard is the only write path.

const workspacePath = resolve(process.argv[2] || process.cwd());
const pagesDir = join(workspacePath, "pages");
const appsDir = join(workspacePath, "apps");
const adiabaticDir = join(workspacePath, ".adiabatic");
const authSecrets: AuthSecrets = {
  coreToken: requireSecret("ADIABATIC_CORE_TOKEN"),
  bridgeToken: requireSecret("ADIABATIC_BRIDGE_TOKEN"),
};
const ADIABATIC_SYSTEM_DTS = `declare module "@adiabatic/system" {
  type JsonValue =
    | null
    | string
    | number
    | boolean
    | JsonValue[]
    | { [key: string]: JsonValue };

  export const system: {
    query(sql: string, params?: unknown[]): Promise<{ rows: unknown[] }>;
    write(sql: string, params?: unknown[]): Promise<{ ok: true }>;
    writeDoc(id: string, content: string, metadata?: Record<string, unknown>): Promise<{ ok: true; id: string }>;
    deleteDoc(id: string): Promise<{ ok: true }>;
    writeEvent(event: {
      type: string;
      startedAt: number;
      endedAt?: number;
      externalId?: string;
      payload: JsonValue;
    }): Promise<{ ok: true; id: string }>;
  };
}
`;

// Ensure .adiabatic/ exists
await mkdir(adiabaticDir, { recursive: true });

// Ensure CLAUDE.md with system section markers
await ensureClaudeMd(workspacePath);

// Boot
const { dataDb, systemDb, close: closeDB } = openDatabases(workspacePath);
const guard = new Guard({ db: dataDb, source: "system:server" });
const settings = new SettingsStore(adiabaticDir);
await settings.update({ workspacePath });
const connectorSupervisor = new ConnectorSupervisor({
  systemDb,
  guard,
  host: { workspacePath },
});
// Built-ins are bundled catalog entries; installing one is an explicit user
// action through the same install flow as any other connector package.
const builtinConnectorsDir = fileURLToPath(new URL("../../template/connectors", import.meta.url));
const connectorManifests = await registerWorkspaceConnectors(connectorSupervisor, workspacePath, {
  skipInvalid: true,
  onError(connectorDir, err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`[adiabatic] Skipping connector ${connectorDir}: ${message}`);
  },
});
const connectorScheduler = new ConnectorScheduler({
  supervisor: connectorSupervisor,
  onError(err, integration) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`[adiabatic] Connector ${integration.connectorId} scheduler error: ${message}`);
  },
});
let registry = await loadApps(appsDir);
const workingTree = new WorkingTree({ guard, pagesDir });
await workingTree.start();

interface SchemaRequest {
  id: string;
  kind: SchemaOp;
  ddl: string[];
  requestedBy: string;
  createdAt: number;
  beforeSchema: unknown;
  status: "pending" | "applied" | "rejected" | "failed";
  error?: string;
}

const schemaRequests = new Map<string, SchemaRequest>();

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
console.log(`[adiabatic] Connectors loaded: ${connectorManifests.map((manifest) => manifest.id).join(", ") || "(none)"}`);

// CORS + cross-origin isolation (required for SharedArrayBuffer / WebContainer)
const ALLOWED_ORIGINS = new Set([
  "http://localhost:5173",
  "http://127.0.0.1:5173",
  "null",
]);

function corsHeaders(req: Request, extra?: Record<string, string>): Record<string, string> {
  const origin = req.headers.get("origin");
  const headers: Record<string, string> = {
    "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": [
      "Authorization",
      "Content-Type",
      APP_ID_HEADER,
      BRIDGE_TOKEN_HEADER,
    ].join(", "),
    "Cross-Origin-Opener-Policy": "same-origin",
    "Cross-Origin-Embedder-Policy": "credentialless",
    Vary: "Origin",
    ...extra,
  };
  if (origin && ALLOWED_ORIGINS.has(origin)) {
    headers["Access-Control-Allow-Origin"] = origin;
  }
  return headers;
}

function isAllowedHost(req: Request): boolean {
  const rawHost = req.headers.get("host");
  if (!rawHost) return false;
  const host = rawHost.toLowerCase().replace(/:\d+$/, "");
  return host === "localhost" || host === "127.0.0.1" || host === "[::1]" || host === "::1";
}

async function readBody<T>(req: Request): Promise<T> {
  return (await req.json()) as T;
}

function guardForRequest(auth: AuthContext, opts?: { requireAppIdentity?: boolean }): Guard {
  if (auth.kind === "host") {
    if (opts?.requireAppIdentity) {
      throw new Error("Guard: app identity is required for this write path");
    }
    return guard;
  }

  const appId = auth.appId;
  const app = registry.apps.get(appId);
  if (!app) {
    throw new Error(`Guard: unknown app identity: ${appId}`);
  }

  return guard.withSource(`app:${appId}`, {
    canWriteTable: (table) => registry.hasWritePermission(appId, table),
  });
}

async function createSchemaRequest(
  kind: SchemaOp,
  ddl: string | string[],
  requestedBy: string,
): Promise<{ status: "pending" | "applied"; request?: SchemaRequest }> {
  if ((await settings.get()).allowCodingAgentSchemaDecisions) {
    if (kind === "promote") {
      guard.promote(ddl, { approved: true, requestedBy });
    } else {
      guard.demote(ddl, { approved: true, requestedBy });
    }
    return { status: "applied" };
  }

  const plan = guard.schemaPlan(kind, ddl);
  const request: SchemaRequest = {
    id: ulid(),
    kind,
    ddl: plan.ddl,
    requestedBy,
    createdAt: Date.now(),
    beforeSchema: plan.before_schema,
    status: "pending",
  };
  schemaRequests.set(request.id, request);
  return { status: "pending", request };
}

async function approveSchemaRequest(id: string, remember: boolean): Promise<SchemaRequest> {
  const request = schemaRequests.get(id);
  if (!request) throw new Error(`Schema request not found: ${id}`);
  if (request.status !== "pending") return request;

  try {
    if (request.kind === "promote") {
      guard.promote(request.ddl, { approved: true, requestedBy: request.requestedBy });
    } else {
      guard.demote(request.ddl, { approved: true, requestedBy: request.requestedBy });
    }
    request.status = "applied";
    if (remember) {
      await settings.update({ allowCodingAgentSchemaDecisions: true });
    }
  } catch (err) {
    request.status = "failed";
    request.error = err instanceof Error ? err.message : String(err);
  }
  return request;
}

function rejectSchemaRequest(id: string): SchemaRequest {
  const request = schemaRequests.get(id);
  if (!request) throw new Error(`Schema request not found: ${id}`);
  if (request.status === "pending") request.status = "rejected";
  return request;
}

async function readAppFiles(appDir: string): Promise<Record<string, string>> {
  const files: Record<string, string> = {};
  async function walk(dir: string, prefix = ""): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name === ".git" || entry.name === "node_modules" || entry.name === "dist") {
        continue;
      }
      const relPath = prefix ? `${prefix}/${entry.name}` : entry.name;
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(fullPath, relPath);
      } else if (entry.isFile()) {
        files[relPath] = await readFile(fullPath, "utf8");
      }
    }
  }
  await walk(appDir);
  return files;
}

function resolveAppFile(appDir: string, filename: string): string {
  const target = join(appDir, filename);
  const rel = relative(appDir, target);
  if (!rel || rel.startsWith("..") || rel.includes("../") || rel === ".git" || rel.startsWith(".git/")) {
    throw new Error("Invalid filename");
  }
  return target;
}

// Track active terminal subprocesses for cleanup
const terminalProcs = new Set<import("bun").Subprocess>();
const ptyHelperPath = join(dirname(new URL(import.meta.url).pathname), "pty-helper.cjs");

// Routes
const server = Bun.serve({
  hostname: process.env.HOST || "127.0.0.1",
  port: Number(process.env.PORT) || 3000,
  idleTimeout: 255, // max — SSE connections need long-lived responses
  async fetch(req, server) {
    const url = new URL(req.url);
    const path = url.pathname;
    const method = req.method;
    const headers = corsHeaders(req);
    const json = (data: unknown, status = 200): Response =>
      new Response(JSON.stringify(data), {
        status,
        headers: { "Content-Type": "application/json", ...headers },
      });

    // CORS preflight
    if (method === "OPTIONS") {
      return new Response(null, { status: 204, headers });
    }

    if (path.startsWith("/api/") && !isAllowedHost(req)) {
      return json({ error: "invalid host" }, 403);
    }

    const auth = path.startsWith("/api/") ? authenticateRequest(req, authSecrets) : null;
    if (path.startsWith("/api/") && !auth) {
      return json({ error: "unauthorized" }, 401);
    }

    // -- Terminal WebSocket upgrade --
    if (path === "/api/terminal") {
      const upgraded = server.upgrade(req, { data: { cwd: workspacePath } });
      if (!upgraded) {
        return new Response("WebSocket upgrade failed", { status: 400, headers });
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
          ...headers,
        },
      });
    }

    try {
      // -- Workspace --
      if (path === "/api/workspace" && method === "GET") {
        return json({ path: workspacePath });
      }

      // -- Docs --
      if (path === "/api/docs" && method === "POST") {
        const body = await readBody<{ id: string; content: string; metadata?: Record<string, unknown> }>(req);
        guardForRequest(auth!).writeDoc(body.id, body.content, body.metadata);
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
        const deleted = guardForRequest(auth!).deleteDoc(docId);
        if (!deleted) return json({ error: "not found" }, 404);
        return json({ ok: true });
      }

      // -- Events --
      if (path === "/api/events" && method === "POST") {
        const body = await readBody<{
          type: string; startedAt: number;
          endedAt?: number; externalId?: string; payload: JsonValue;
        }>(req);
        const id = guardForRequest(auth!).writeEvent(body);
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
        guardForRequest(auth!, { requireAppIdentity: true }).write(body.sql, body.params);
        return json({ ok: true });
      }

      // -- Schema lifecycle request/approval --
      const schemaRequestMatch = path.match(/^\/api\/schema\/(promote|demote)\/request$/);
      if (schemaRequestMatch && method === "POST") {
        const kind = schemaRequestMatch[1] as SchemaOp;
        const body = await readBody<{ ddl: string | string[]; requestedBy?: string }>(req);
        const requestedBy = body.requestedBy ?? (auth?.kind === "bridge" ? auth.appId : null) ?? "coding-agent";
        const result = await createSchemaRequest(kind, body.ddl, requestedBy);
        return json(result);
      }

      if (path === "/api/schema/requests" && method === "GET") {
        return json({ requests: [...schemaRequests.values()] });
      }

      const schemaRequestById = path.match(/^\/api\/schema\/requests\/([^/]+)$/);
      if (schemaRequestById && method === "GET") {
        const request = schemaRequests.get(decodeURIComponent(schemaRequestById[1]));
        if (!request) return json({ error: "not found" }, 404);
        return json({ request });
      }

      const approveMatch = path.match(/^\/api\/schema\/requests\/([^/]+)\/approve$/);
      if (approveMatch && method === "POST") {
        const body = await readBody<{ remember?: boolean }>(req);
        const request = await approveSchemaRequest(decodeURIComponent(approveMatch[1]), body.remember === true);
        return json({ request });
      }

      const rejectMatch = path.match(/^\/api\/schema\/requests\/([^/]+)\/reject$/);
      if (rejectMatch && method === "POST") {
        const request = rejectSchemaRequest(decodeURIComponent(rejectMatch[1]));
        return json({ request });
      }

      // -- Connectors --
      if (path === "/api/connectors" && method === "GET") {
        if (auth!.kind !== "host") return json({ error: "host auth required" }, 403);
        return json({ connectors: await connectorSupervisor.list() });
      }

      // Bundled catalog entries; installed reflects whether the package is
      // currently registered in the workspace.
      if (path === "/api/connectors/available" && method === "GET") {
        if (auth!.kind !== "host") return json({ error: "host auth required" }, 403);
        const platform = currentConnectorPlatform();
        const entries = await listAvailableBuiltIns(builtinConnectorsDir, (dir, err) => {
          const message = err instanceof Error ? err.message : String(err);
          console.warn(`[adiabatic] Skipping bundled connector ${dir}: ${message}`);
        });
        const available = entries.map((entry) => ({
          connectorId: entry.manifest.id,
          name: entry.manifest.name,
          mode: entry.manifest.runtime.mode,
          integrationsMode: entry.manifest.integrations.mode,
          authType: entry.manifest.auth.type,
          supported: isPlatformSupported(entry.manifest, platform),
          installed: connectorSupervisor.isRegistered(entry.manifest.id),
        }));
        return json({ available });
      }

      const installConnectorMatch = path.match(/^\/api\/connectors\/([^/]+)\/install$/);
      if (installConnectorMatch && method === "POST") {
        if (auth!.kind !== "host") return json({ error: "host auth required" }, 403);
        const connectorId = decodeURIComponent(installConnectorMatch[1]);
        const installed = await installConnectorFromSource({
          sourceDir: join(builtinConnectorsDir, connectorId),
          workspacePath,
          connectorId,
          guard,
        });
        const manifest = await connectorSupervisor.registerDirectory(installed.dir);
        connectorSupervisor.ensureFirstIntegration(manifest.id);
        return json({ ok: true, manifest });
      }

      const approveConnectorMatch = path.match(/^\/api\/connectors\/([^/]+)\/approve$/);
      if (approveConnectorMatch && method === "POST") {
        if (auth!.kind !== "host") return json({ error: "host auth required" }, 403);
        const manifest = await connectorSupervisor.approveCurrentPackage(decodeURIComponent(approveConnectorMatch[1]));
        return json({ ok: true, manifest });
      }

      const requirementsCheckMatch = path.match(/^\/api\/connectors\/integrations\/([^/]+)\/requirements\/check$/);
      if (requirementsCheckMatch && method === "POST") {
        if (auth!.kind !== "host") return json({ error: "host auth required" }, 403);
        const requirements = await connectorSupervisor.checkIntegrationRequirements(
          decodeURIComponent(requirementsCheckMatch[1]),
        );
        return json({ requirements });
      }

      const removeConnectorMatch = path.match(/^\/api\/connectors\/([^/]+)$/);
      if (removeConnectorMatch && method === "DELETE") {
        if (auth!.kind !== "host") return json({ error: "host auth required" }, 403);
        const connectorId = decodeURIComponent(removeConnectorMatch[1]);
        const removed = await removeInstalledConnector(workspacePath, connectorId);
        await connectorSupervisor.unregister(connectorId);
        return json({ ok: true, removed });
      }

      const createIntegrationMatch = path.match(/^\/api\/connectors\/([^/]+)\/integrations$/);
      if (createIntegrationMatch && method === "POST") {
        if (auth!.kind !== "host") return json({ error: "host auth required" }, 403);
        const body = await readBody<{ integrationKey?: string; scheduleCron?: string | null; config?: unknown }>(req);
        const integration = connectorSupervisor.ensureIntegration({
          connectorId: decodeURIComponent(createIntegrationMatch[1]),
          integrationKey: body.integrationKey,
          scheduleCron: body.scheduleCron,
          config: body.config,
        });
        return json({ integration });
      }

      const integrationMatch = path.match(/^\/api\/connectors\/integrations\/([^/]+)$/);
      if (integrationMatch && method === "PATCH") {
        if (auth!.kind !== "host") return json({ error: "host auth required" }, 403);
        const body = await readBody<{
          enabled?: boolean;
          scheduleCron?: string | null;
          integrationKey?: string;
          config?: unknown;
        }>(req);
        const instanceId = decodeURIComponent(integrationMatch[1]);
        connectorSupervisor.updateIntegration(instanceId, {
          enabled: body.enabled,
          scheduleCron: body.scheduleCron,
          integrationKey: body.integrationKey,
          config: body.config,
        });
        const integration = await connectorSupervisor.refreshIntegrationSetup(instanceId);
        return json({ integration });
      }
      if (integrationMatch && method === "DELETE") {
        if (auth!.kind !== "host") return json({ error: "host auth required" }, 403);
        await connectorSupervisor.removeIntegration(decodeURIComponent(integrationMatch[1]));
        return json({ ok: true });
      }

      const connectIntegrationMatch = path.match(/^\/api\/connectors\/integrations\/([^/]+)\/connect$/);
      if (connectIntegrationMatch && method === "POST") {
        if (auth!.kind !== "host") return json({ error: "host auth required" }, 403);
        const body = await readBody<{ token?: string }>(req);
        const integration = await connectorSupervisor.connectIntegrationWithToken(
          decodeURIComponent(connectIntegrationMatch[1]),
          body.token ?? "",
        );
        return json({ integration });
      }

      const restartIntegrationMatch = path.match(/^\/api\/connectors\/integrations\/([^/]+)\/restart$/);
      if (restartIntegrationMatch && method === "POST") {
        if (auth!.kind !== "host") return json({ error: "host auth required" }, 403);
        const integration = connectorSupervisor.restartIntegration(
          decodeURIComponent(restartIntegrationMatch[1]),
        );
        // Kick the scheduler so the restart takes effect immediately instead of
        // waiting for the next tick; don't block the response on it.
        connectorScheduler.tick().catch((err) => {
          console.warn(`[adiabatic] Connector scheduler tick after restart failed: ${err}`);
        });
        return json({ integration });
      }

      const requirementRequestMatch = path.match(
        /^\/api\/connectors\/integrations\/([^/]+)\/requirements\/([^/]+)\/request$/,
      );
      if (requirementRequestMatch && method === "POST") {
        if (auth!.kind !== "host") return json({ error: "host auth required" }, 403);
        const requirement = await connectorSupervisor.requestIntegrationRequirement(
          decodeURIComponent(requirementRequestMatch[1]),
          decodeURIComponent(requirementRequestMatch[2]),
        );
        return json({ requirement });
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
          return json(await readAppFiles(app.dir));
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
          join(appDir, "package.json"),
          JSON.stringify({
            name: `adiabatic-app-${id}`,
            version: "0.1.0",
            type: "module",
            scripts: { dev: "vite" },
            dependencies: {
              react: "^19.0.0",
              "react-dom": "^19.0.0",
            },
            devDependencies: {
              "@vitejs/plugin-react": "^4.0.0",
              typescript: "^5.7.0",
              vite: "^6.0.0",
            },
          }, null, 2) + "\n",
        );
        await writeFile(
          join(appDir, "index.tsx"),
          `// ${name} — app entry point\nimport React from "react";\n\nexport default function ${name.replace(/[^a-zA-Z0-9]/g, "")}() {\n  return <div>${name}</div>;\n}\n`,
        );
        await writeFile(join(appDir, "adiabatic-system.d.ts"), ADIABATIC_SYSTEM_DTS);
        try {
          await Bun.spawn(["git", "init"], { cwd: appDir }).exited;
        } catch (err) {
          console.warn(`[adiabatic] Could not initialize git for ${id}:`, err);
        }

        // Reload registry
        registry = await loadApps(appsDir);
        return json({ ok: true, id });
      }

      // -- Save App File --
      const fileMatch = path.match(/^\/api\/apps\/([^/]+)\/files\/(.+)$/);
      if (fileMatch && method === "PUT") {
        const appId = decodeURIComponent(fileMatch[1]);
        const filename = decodeURIComponent(fileMatch[2]);

        const app = registry.apps.get(appId);
        if (!app) return json({ error: "app not found" }, 404);

        const body = await readBody<{ content: string }>(req);
        const filePath = resolveAppFile(app.dir, filename);
        await mkdir(dirname(filePath), { recursive: true });
        await writeFile(filePath, body.content);

        // Reload registry if manifest was modified
        if (filename === "manifest.json" || filename === "package.json") {
          registry = await loadApps(appsDir);
        }

        return json({ ok: true });
      }

      // -- Shell (static SPA) --
      const shellDir = process.env.SHELL_DIST;
      if (shellDir) {
        // Try exact file first, then fall back to index.html (SPA routing)
        const filePath = join(shellDir, path === "/" ? "index.html" : path);
        try {
          const info = await stat(filePath);
          if (info.isFile()) return new Response(Bun.file(filePath), { headers });
        } catch {}
        // SPA fallback: serve index.html for non-file routes
        try {
          const indexPath = join(shellDir, "index.html");
          await stat(indexPath);
          return new Response(Bun.file(indexPath), { headers });
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

      // PTY stdout → WebSocket
      (async () => {
        const reader = proc.stdout.getReader();
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            ws.send(value);
          }
        } catch {}
        terminalProcs.delete(proc);
        try { ws.close(); } catch {}
      })();

      // PTY stderr → WebSocket
      (async () => {
        const reader = proc.stderr.getReader();
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            ws.send(value);
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
    },
    close(ws) {
      const proc = (ws as any)._proc as import("bun").Subprocess | undefined;
      if (proc) {
        terminalProcs.delete(proc);
        try { proc.kill(); } catch {}
      }
    },
  },
});

connectorScheduler.start().catch((err) => {
  console.error("[adiabatic] Connector scheduler failed:", err);
});

console.log(`[adiabatic] Server running on http://localhost:${server.port}`);

let shuttingDown = false;

// Graceful shutdown
async function shutdown(): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log("\n[adiabatic] Shutting down...");
  await connectorScheduler.stop();
  for (const proc of terminalProcs) {
    try { proc.kill(); } catch {}
  }
  terminalProcs.clear();
  workingTree.stop();
  closeDB();
  process.exit(0);
}

process.on("SIGINT", () => {
  shutdown().catch((err) => {
    console.error("[adiabatic] Shutdown failed:", err);
    process.exit(1);
  });
});
process.on("SIGTERM", () => {
  shutdown().catch((err) => {
    console.error("[adiabatic] Shutdown failed:", err);
    process.exit(1);
  });
});
