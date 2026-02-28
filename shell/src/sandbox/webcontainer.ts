// WebContainer — boots and manages the WASM sandbox instance.
//
// One WebContainer for the entire app sandbox system.
// All apps run inside it: component bundling, logic, crons.
// Communication with core Guard goes through a bridge-server inside the container.
//
// Architecture:
//   Electron Renderer (Chromium)
//   ├── Host page (BlockNote + React)
//   │   └── dynamic import from WebContainer's server URL
//   └── WebContainer (WASM sandbox)
//       ├── apps/*          ← app code mounted here
//       ├── bridge-server.js ← serves bundles + proxies system.* to core
//       └── bundles/*       ← esbuild output (ESM for browser)

import { WebContainer } from "@webcontainer/api";
import { SANDBOX_FILES } from "./sandbox-files";
import type { AppInfo } from "../lib/api";

let instance: WebContainer | null = null;
let serverUrl: string | null = null;

export async function boot(): Promise<void> {
  if (instance) return;

  console.log("[sandbox] Booting WebContainer...");
  instance = await WebContainer.boot();

  // Mount scaffold files (package.json, bridge-server, bundler)
  await instance.mount(SANDBOX_FILES);

  // Install dependencies inside the container
  console.log("[sandbox] Installing sandbox dependencies...");
  const installProcess = await instance.spawn("npm", ["install"]);

  const installExit = await installProcess.exit;
  if (installExit !== 0) {
    throw new Error(`npm install failed with exit code ${installExit}`);
  }

  console.log("[sandbox] WebContainer ready.");
}

// Load apps into the WebContainer filesystem and bundle them.
export async function loadApps(apps: AppInfo[]): Promise<void> {
  if (!instance) throw new Error("WebContainer not booted");

  // Fetch each app's source from core and write into the container
  for (const app of apps) {
    // Fetch the raw source files from core
    const res = await fetch(`http://localhost:3000/api/apps/${app.id}/source`);
    if (!res.ok) continue;

    const files = (await res.json()) as Record<string, string>;

    // Write app files into /apps/{appId}/
    await instance.fs.mkdir(`/apps/${app.id}`, { recursive: true });
    for (const [filename, content] of Object.entries(files)) {
      await instance.fs.writeFile(`/apps/${app.id}/${filename}`, content);
    }
  }

  // Run the bundler to produce browser-ready ESM for each app
  console.log("[sandbox] Bundling apps...");
  const bundleProcess = await instance.spawn("node", ["bundler.js"]);

  bundleProcess.output.pipeTo(
    new WritableStream({
      write(chunk) {
        console.log("[sandbox:bundler]", chunk);
      },
    }),
  );

  const bundleExit = await bundleProcess.exit;
  if (bundleExit !== 0) {
    console.error("[sandbox] Bundler failed with exit code", bundleExit);
  }
}

// Start the bridge server inside the WebContainer.
// Returns the URL where bundles and system.* proxy are served.
export async function startBridgeServer(): Promise<string> {
  if (!instance) throw new Error("WebContainer not booted");
  if (serverUrl) return serverUrl;

  console.log("[sandbox] Starting bridge server...");
  const serverProcess = await instance.spawn("node", ["bridge-server.js"]);

  serverProcess.output.pipeTo(
    new WritableStream({
      write(chunk) {
        console.log("[sandbox:bridge]", chunk);
      },
    }),
  );

  // Wait for server-ready event from WebContainer
  serverUrl = await new Promise<string>((resolve) => {
    instance!.on("server-ready", (_port, url) => {
      console.log("[sandbox] Bridge server ready at", url);
      resolve(url);
    });
  });

  return serverUrl;
}

// Get the server URL (after startBridgeServer).
export function getServerUrl(): string | null {
  return serverUrl;
}

// Get the WebContainer instance.
export function getContainer(): WebContainer | null {
  return instance;
}

// Reload an app's files and re-bundle.
export async function reloadApp(appId: string): Promise<void> {
  if (!instance) throw new Error("WebContainer not booted");

  const res = await fetch(`http://localhost:3000/api/apps/${appId}/source`);
  if (!res.ok) throw new Error(`Failed to fetch app source: ${res.status}`);

  const files = (await res.json()) as Record<string, string>;
  for (const [filename, content] of Object.entries(files)) {
    await instance.fs.writeFile(`/apps/${appId}/${filename}`, content);
  }

  // Re-bundle just this app
  const proc = await instance.spawn("node", ["bundler.js", appId]);
  await proc.exit;
}

// Tear down the WebContainer.
export async function teardown(): Promise<void> {
  instance?.teardown();
  instance = null;
  serverUrl = null;
}
