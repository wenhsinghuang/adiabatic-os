// Component Registry — dynamic resolution of component names to live React components.
//
// Flow:
//   1. Fetch app list from core → build name→appId index
//   2. When a component is needed, load its app's bundle from WebContainer
//   3. Extract the named export → return as React component
//
// Apps run inside a WebContainer (WASM sandbox). The bundle is produced by
// esbuild inside the container and served via the bridge-server.
// System.* calls from components route through the bridge-server to core Guard.

import type { ComponentType } from "react";
import type { AppInfo } from "../lib/api";
import { createSystemBridge, type System } from "../sandbox/system-bridge";

export interface ResolvedComponent {
  Component: ComponentType<Record<string, unknown>>;
  appId: string;
  system: System;
}

// Cached app modules: appId → module exports
const moduleCache = new Map<string, Record<string, unknown>>();

// Component name → appId reverse index
const componentIndex = new Map<string, string>();

// App info by id
const appIndex = new Map<string, AppInfo>();

// Per-app system bridges (cached)
const bridgeCache = new Map<string, System>();

// Module loader: provided by sandbox/app-bundler.ts
let moduleLoader: ((appId: string, entryPoint: string) => Promise<Record<string, unknown>>) | null =
  null;

export function setModuleLoader(
  loader: (appId: string, entryPoint: string) => Promise<Record<string, unknown>>,
): void {
  moduleLoader = loader;
}

// Register apps from core's /api/apps response.
export function registerApps(apps: AppInfo[]): void {
  componentIndex.clear();
  appIndex.clear();
  for (const app of apps) {
    appIndex.set(app.id, app);
    for (const comp of app.components) {
      componentIndex.set(comp, app.id);
    }
  }
}

export function getRegisteredComponentNames(): string[] {
  return [...componentIndex.keys()];
}

export function isRegisteredComponent(name: string): boolean {
  return componentIndex.has(name);
}

async function loadAppModule(appId: string): Promise<Record<string, unknown>> {
  const cached = moduleCache.get(appId);
  if (cached) return cached;

  const app = appIndex.get(appId);
  if (!app) throw new Error(`App not found: ${appId}`);
  if (!moduleLoader) throw new Error("Module loader not initialized");

  const mod = await moduleLoader(appId, app.entryPoint);
  moduleCache.set(appId, mod);
  return mod;
}

function getSystemBridge(appId: string): System {
  let bridge = bridgeCache.get(appId);
  if (!bridge) {
    bridge = createSystemBridge(appId);
    bridgeCache.set(appId, bridge);
  }
  return bridge;
}

// Resolve a component name to a live React component + metadata.
export async function resolveComponent(
  componentName: string,
): Promise<ResolvedComponent | null> {
  const appId = componentIndex.get(componentName);
  if (!appId) return null;

  try {
    const mod = await loadAppModule(appId);
    const Component = mod[componentName] as ComponentType<Record<string, unknown>> | undefined;
    if (!Component) {
      console.warn(`[registry] Component "${componentName}" not exported from app "${appId}"`);
      return null;
    }

    return {
      Component,
      appId,
      system: getSystemBridge(appId),
    };
  } catch (err) {
    console.error(
      `[registry] Failed to load component "${componentName}" from app "${appId}":`,
      err,
    );
    return null;
  }
}

// Invalidate cache for an app (e.g. after hot-reload).
export function invalidateApp(appId: string): void {
  moduleCache.delete(appId);
  bridgeCache.delete(appId);
}
