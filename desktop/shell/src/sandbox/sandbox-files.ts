// Files mounted inside the WebContainer filesystem.
// The container serves app pages and proxies system calls to core Guard.

import type { FileSystemTree } from "@webcontainer/api";

export const SANDBOX_FILES: FileSystemTree = {
  "package.json": {
    file: {
      contents: JSON.stringify(
        {
          name: "adiabatic-sandbox",
          type: "module",
          dependencies: {
            "@vitejs/plugin-react": "^4.0.0",
            esbuild: "^0.24.0",
            react: "^19.0.0",
            "react-dom": "^19.0.0",
            typescript: "^5.7.0",
            vite: "^6.0.0",
          },
        },
        null,
        2,
      ),
    },
  },

  shims: {
    directory: {
      "system.js": {
        file: {
          contents: `
async function call(method, body) {
  const match = window.location.pathname.match(/^\\/apps\\/([^/]+)\\//);
  if (!match) throw new Error("Missing app identity");
  const appId = decodeURIComponent(match[1]);
  const res = await fetch("/system/" + method, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Adiabatic-App-Id": appId },
    body: JSON.stringify(body ?? {}),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || "system." + method + " failed");
  return data;
}

export const system = {
  query(sql, params) {
    return call("query", { sql, params });
  },
  write(sql, params) {
    return call("write", { sql, params });
  },
  writeDoc(id, content, metadata) {
    return call("writeDoc", { id, content, metadata });
  },
  deleteDoc(id) {
    return call("deleteDoc", { id });
  },
  writeEvent(event) {
    return call("writeEvent", event);
  },
};

export default system;
`,
        },
      },
    },
  },

  "bundler.js": {
    file: {
      contents: `
import { build } from "esbuild";
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "fs";
import { dirname, resolve } from "path";

const APPS_DIR = "./apps";
const RUNTIME_DIR = "./runtime";
const targetApp = process.argv[2] || null;

if (!existsSync(RUNTIME_DIR)) mkdirSync(RUNTIME_DIR, { recursive: true });

let apps;
try {
  apps = readdirSync(APPS_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);
} catch {
  console.log("No apps/ directory found.");
  process.exit(0);
}

if (targetApp) apps = apps.filter((appId) => appId === targetApp);

const alias = {
  "@adiabatic/system": resolve("./shims/system.js"),
};

function findEntry(appId) {
  const candidates = [
    APPS_DIR + "/" + appId + "/index.tsx",
    APPS_DIR + "/" + appId + "/src/App.tsx",
    APPS_DIR + "/" + appId + "/src/main.tsx",
  ];
  return candidates.find((file) => existsSync(file)) || null;
}

for (const appId of apps) {
  const appEntry = findEntry(appId);
  if (!appEntry) {
    console.log("Skip " + appId + ": no app entry point");
    continue;
  }

  const entry = RUNTIME_DIR + "/" + appId + ".entry.tsx";
  mkdirSync(dirname(entry), { recursive: true });
  writeFileSync(entry, \`
import * as React from "react";
import { createRoot } from "react-dom/client";
import * as AppModule from "../\${appEntry}";

const Component = AppModule.default || Object.values(AppModule).find((value) => typeof value === "function");
const root = document.getElementById("root");

if (!root) {
  throw new Error("Missing #root");
}
if (!Component) {
  root.textContent = "App has no default export or function export.";
} else {
  createRoot(root).render(React.createElement(Component));
}
\`);

  try {
    await build({
      entryPoints: [entry],
      bundle: true,
      format: "esm",
      target: "es2022",
      outfile: RUNTIME_DIR + "/" + appId + ".js",
      alias,
      jsx: "automatic",
      logLevel: "warning",
    });
    console.log("Bundled app page: " + appId);
  } catch (err) {
    console.error("Bundle failed for " + appId + ":", err.message);
  }
}
`,
    },
  },

  "bridge-server.js": {
    file: {
      contents: `
import { createServer } from "http";
import { readFile } from "fs/promises";
import { existsSync } from "fs";

const CORE_URL = process.env.ADIABATIC_CORE_URL || "http://localhost:3000";
const PORT = 4000;
const APP_ID_HEADER = "X-Adiabatic-App-Id";
const BRIDGE_TOKEN_HEADER = "X-Adiabatic-Bridge-Token";
const BRIDGE_TOKEN = process.env.ADIABATIC_BRIDGE_TOKEN;

function send(res, status, body, headers = {}) {
  res.writeHead(status, headers);
  res.end(body);
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost:" + PORT);

  if (req.method === "GET" && url.pathname.startsWith("/apps/")) {
    const match = url.pathname.match(/^\\/apps\\/([^/]+)\\/?$/);
    if (!match) return send(res, 404, "Not found");
    const appId = decodeURIComponent(match[1]);
    const bundle = "./runtime/" + appId + ".js";
    if (!existsSync(bundle)) return send(res, 404, "App bundle not found");
    const html = \`<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta
      http-equiv="Content-Security-Policy"
      content="default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data: blob:;"
    />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>\${appId}</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/runtime/\${encodeURIComponent(appId)}.js"></script>
  </body>
</html>\`;
    return send(res, 200, html, { "Content-Type": "text/html" });
  }

  if (req.method === "GET" && url.pathname.startsWith("/runtime/")) {
    const filename = "./runtime/" + url.pathname.slice("/runtime/".length);
    if (!existsSync(filename)) return send(res, 404, "Not found");
    const code = await readFile(filename, "utf8");
    return send(res, 200, code, { "Content-Type": "application/javascript" });
  }

  if (req.method === "POST" && url.pathname.startsWith("/system/")) {
    const rawAppId = req.headers[APP_ID_HEADER.toLowerCase()];
    const appId = Array.isArray(rawAppId) ? rawAppId[0] : rawAppId;
    if (!appId) {
      return send(res, 403, JSON.stringify({ error: "Missing app identity" }), { "Content-Type": "application/json" });
    }
    if (!BRIDGE_TOKEN) {
      return send(res, 500, JSON.stringify({ error: "Missing bridge token" }), { "Content-Type": "application/json" });
    }

    const method = url.pathname.slice("/system/".length);
    let body = "";
    for await (const chunk of req) body += chunk;

    let coreMethod = "POST";
    let corePath;
    switch (method) {
      case "query": corePath = "/api/query"; break;
      case "write": corePath = "/api/write"; break;
      case "writeDoc": corePath = "/api/docs"; break;
      case "writeEvent": corePath = "/api/events"; break;
      case "deleteDoc": {
        const parsed = body ? JSON.parse(body) : {};
        if (!parsed.id) return send(res, 400, JSON.stringify({ error: "deleteDoc requires id" }), { "Content-Type": "application/json" });
        coreMethod = "DELETE";
        corePath = "/api/docs/" + encodeURIComponent(parsed.id);
        body = "";
        break;
      }
      default:
        return send(res, 400, JSON.stringify({ error: "Unknown method: " + method }), { "Content-Type": "application/json" });
    }

    try {
      const coreRes = await fetch(CORE_URL + corePath, {
        method: coreMethod,
        headers: { "Content-Type": "application/json", [APP_ID_HEADER]: appId, [BRIDGE_TOKEN_HEADER]: BRIDGE_TOKEN },
        body: coreMethod === "DELETE" ? undefined : body,
      });
      const data = await coreRes.text();
      return send(res, coreRes.status, data, { "Content-Type": "application/json" });
    } catch (err) {
      return send(res, 502, JSON.stringify({ error: "Core unreachable: " + err.message }), { "Content-Type": "application/json" });
    }
  }

  send(res, 404, "Not found");
});

server.listen(PORT, () => {
  console.log("Bridge server listening on port " + PORT);
});
`,
    },
  },

  apps: { directory: {} },
  runtime: { directory: {} },
};
