// Files mounted inside the WebContainer filesystem.
// These are the sandbox's internal scaffold: package.json, bundler, bridge server.

import type { FileSystemTree } from "@webcontainer/api";

export const SANDBOX_FILES: FileSystemTree = {
  "package.json": {
    file: {
      contents: JSON.stringify(
        {
          name: "adiabatic-sandbox",
          type: "module",
          dependencies: {
            esbuild: "^0.24.0",
          },
        },
        null,
        2,
      ),
    },
  },

  // Bundler — takes each app in /apps/ and produces /bundles/{appId}.js
  // React is externalized (provided by the host page).
  "bundler.js": {
    file: {
      contents: `
import { build } from "esbuild";
import { readdirSync, existsSync, mkdirSync } from "fs";

const APPS_DIR = "/apps";
const BUNDLES_DIR = "/bundles";
const targetApp = process.argv[2] || null; // optional: bundle single app

if (!existsSync(BUNDLES_DIR)) mkdirSync(BUNDLES_DIR, { recursive: true });

let apps;
try {
  apps = readdirSync(APPS_DIR);
} catch {
  console.log("No apps/ directory found.");
  process.exit(0);
}

if (targetApp) {
  apps = apps.filter((a) => a === targetApp);
}

for (const appId of apps) {
  const entry = APPS_DIR + "/" + appId + "/index.tsx";
  if (!existsSync(entry)) {
    console.log("Skip " + appId + ": no index.tsx");
    continue;
  }

  try {
    await build({
      entryPoints: [entry],
      bundle: true,
      format: "esm",
      target: "es2022",
      outfile: BUNDLES_DIR + "/" + appId + ".js",
      external: ["react", "react-dom", "react/jsx-runtime"],
      jsx: "automatic",
      logLevel: "warning",
    });
    console.log("Bundled: " + appId);
  } catch (err) {
    console.error("Bundle failed for " + appId + ":", err.message);
  }
}

console.log("Bundler done.");
`,
    },
  },

  // Bridge server — serves two things:
  // 1. GET /bundles/{appId}.js — bundled app code for dynamic import
  // 2. POST /system/{method} — proxy to core Guard (system.* bridge)
  //
  // Components loaded in the host page call system.* via this server,
  // which forwards to core. This ensures all system calls route through
  // the sandbox (app identity is enforced here).
  "bridge-server.js": {
    file: {
      contents: `
import { createServer } from "http";
import { readFile } from "fs/promises";
import { existsSync } from "fs";

const CORE_URL = "http://localhost:3000";
const PORT = 4000;

const server = createServer(async (req, res) => {
  // CORS
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-App-Id");
  if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }

  const url = new URL(req.url, "http://localhost:" + PORT);

  // Serve bundled app code
  if (req.method === "GET" && url.pathname.startsWith("/bundles/")) {
    const filename = "/bundles/" + url.pathname.slice("/bundles/".length);
    if (!existsSync(filename)) {
      res.writeHead(404); res.end("Not found"); return;
    }
    const code = await readFile(filename, "utf8");
    res.writeHead(200, { "Content-Type": "application/javascript" });
    res.end(code);
    return;
  }

  // System bridge: proxy to core Guard
  // POST /system/query  → POST core/api/query
  // POST /system/write  → POST core/api/write
  // POST /system/docs   → POST core/api/docs
  // etc.
  if (req.method === "POST" && url.pathname.startsWith("/system/")) {
    const method = url.pathname.slice("/system/".length);
    const appId = req.headers["x-app-id"] || "unknown";

    let body = "";
    for await (const chunk of req) body += chunk;

    // Map system methods to core API endpoints
    let corePath;
    switch (method) {
      case "query":     corePath = "/api/query"; break;
      case "write":     corePath = "/api/write"; break;
      case "writeDoc":  corePath = "/api/docs"; break;
      case "writeEvent": corePath = "/api/events"; break;
      default:
        res.writeHead(400); res.end(JSON.stringify({ error: "Unknown method: " + method })); return;
    }

    try {
      const coreRes = await fetch(CORE_URL + corePath, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: body,
      });
      const data = await coreRes.text();
      res.writeHead(coreRes.status, { "Content-Type": "application/json" });
      res.end(data);
    } catch (err) {
      res.writeHead(502);
      res.end(JSON.stringify({ error: "Core unreachable: " + err.message }));
    }
    return;
  }

  res.writeHead(404);
  res.end("Not found");
});

server.listen(PORT, () => {
  console.log("Bridge server listening on port " + PORT);
});
`,
    },
  },

  // App directory (initially empty, populated at runtime)
  apps: {
    directory: {},
  },

  // Bundles directory (created by bundler)
  bundles: {
    directory: {},
  },
};
