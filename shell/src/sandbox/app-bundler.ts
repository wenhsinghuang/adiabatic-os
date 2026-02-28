// App module loader — dynamic-imports app components from the WebContainer's bundle server.
//
// Flow:
//   1. WebContainer bundles each app with esbuild → /bundles/{appId}.js
//   2. Bridge server serves these at GET /bundles/{appId}.js
//   3. This loader fetches the bundle, creates a blob URL, and dynamic-imports it
//   4. The module's named exports are React components
//
// React is externalized at bundle time — the host provides it.

import { getServerUrl } from "./webcontainer";

const moduleCache = new Map<string, Record<string, unknown>>();

export async function appModuleLoader(
  appId: string,
  _entryPoint: string,
): Promise<Record<string, unknown>> {
  const cached = moduleCache.get(appId);
  if (cached) return cached;

  const baseUrl = getServerUrl();
  if (!baseUrl) throw new Error("Sandbox not ready");

  const res = await fetch(`${baseUrl}/bundles/${appId}.js`);
  if (!res.ok) {
    throw new Error(`Failed to load bundle for "${appId}": ${res.status}`);
  }

  const code = await res.text();
  const blob = new Blob([code], { type: "application/javascript" });
  const url = URL.createObjectURL(blob);

  try {
    const mod = await import(/* @vite-ignore */ url);
    const exports = { ...mod } as Record<string, unknown>;
    moduleCache.set(appId, exports);
    return exports;
  } finally {
    URL.revokeObjectURL(url);
  }
}

export function invalidateAppModule(appId: string): void {
  moduleCache.delete(appId);
}
