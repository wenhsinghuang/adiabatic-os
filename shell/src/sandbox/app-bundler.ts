// App Bundler — dynamic module loading for app components in the browser.
//
// D1 approach: fetch the app's source via a special core API endpoint,
// then compile it as a blob module for dynamic import.
//
// Future: pre-bundle with esbuild at startup, serve from a known URL,
// or use WebContainers for full isolation.
//
// For now, we use a simpler approach: the app's compiled output is served
// by the core server, and we dynamic-import it.

import { compile } from "@mdx-js/mdx";

// Module cache to avoid re-compilation
const compiledModules = new Map<string, Record<string, unknown>>();

// D1 module loader: fetches app source and evaluates it.
// In production, this would load pre-bundled ESM from the core server.
// For D1, we use a fetch + Function approach for simplicity.
export async function appModuleLoader(
  appId: string,
  entryPoint: string,
): Promise<Record<string, unknown>> {
  const cached = compiledModules.get(appId);
  if (cached) return cached;

  // Fetch the app's bundled module from core server
  // Core serves app bundles at /api/apps/:id/bundle
  const res = await fetch(`http://localhost:3000/api/apps/${appId}/bundle`);

  if (!res.ok) {
    throw new Error(`Failed to load app bundle for "${appId}": ${res.status}`);
  }

  const code = await res.text();

  // Create a blob URL and dynamic-import it
  const blob = new Blob([code], { type: "application/javascript" });
  const url = URL.createObjectURL(blob);

  try {
    const mod = await import(/* @vite-ignore */ url);
    const exports = { ...mod } as Record<string, unknown>;
    compiledModules.set(appId, exports);
    return exports;
  } finally {
    URL.revokeObjectURL(url);
  }
}

// Invalidate cached module (e.g. on hot reload)
export function invalidateAppModule(appId: string): void {
  compiledModules.delete(appId);
}
