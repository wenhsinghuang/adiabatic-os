// App module loader — reads bundled app code directly from WebContainer filesystem.
//
// Flow:
//   1. WebContainer bundles each app with esbuild → ./bundles/{appId}.js
//      React imports are resolved to shim modules at bundle time (via esbuild alias),
//      so the output has no bare module specifiers.
//   2. This loader reads the bundle via container.fs.readFile (no HTTP)
//   3. Creates a blob URL and dynamic-imports it
//   4. The module's named exports are React components
//
// The shim modules inside WebContainer read from globalThis.__ADIABATIC_REACT__ etc.,
// which are set here from the host page's React.

import * as React from "react";
import * as ReactDOM from "react-dom";
import * as jsxRuntime from "react/jsx-runtime";
import { getContainer } from "./webcontainer";

// Expose host React on globalThis so shim modules (bundled into app code) can access them
(globalThis as any).__ADIABATIC_REACT__ = React;
(globalThis as any).__ADIABATIC_REACT_DOM__ = ReactDOM;
(globalThis as any).__ADIABATIC_JSX_RUNTIME__ = jsxRuntime;

const moduleCache = new Map<string, Record<string, unknown>>();

export async function appModuleLoader(
  appId: string,
  _entryPoint: string,
): Promise<Record<string, unknown>> {
  const cached = moduleCache.get(appId);
  if (cached) return cached;

  const container = getContainer();
  if (!container) throw new Error("Sandbox not ready");

  const code = await container.fs.readFile(`./bundles/${appId}.js`, "utf-8");
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
