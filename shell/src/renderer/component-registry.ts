// Component Registry — dynamic resolution of component names to live React components.
//
// Flow:
//   1. Fetch app list from core → build name→appId index
//   2. When a component is needed, dynamically import the app's bundled module
//   3. Extract the named export → return as React component
//
// D1 approach: apps are bundled by esbuild into browser-compatible ES modules.
// The registry lazy-loads each app's bundle on first component reference.

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

// Get all known component names.
export function getRegisteredComponentNames(): string[] {
  return [...componentIndex.keys()];
}

// Check if a component name is registered.
export function isRegisteredComponent(name: string): boolean {
  return componentIndex.has(name);
}

// Load an app module. D1: uses a module loader function provided at init.
// The loader takes an app's entry point path and returns the module exports.
let moduleLoader: ((appId: string, entryPoint: string) => Promise<Record<string, unknown>>) | null = null;

export function setModuleLoader(
  loader: (appId: string, entryPoint: string) => Promise<Record<string, unknown>>,
): void {
  moduleLoader = loader;
}

async function loadAppModule(appId: string): Promise<Record<string, unknown>> {
  const cached = moduleCache.get(appId);
  if (cached) return cached;

  const app = appIndex.get(appId);
  if (!app) throw new Error(`App not found: ${appId}`);

  if (!moduleLoader) {
    throw new Error("Module loader not initialized. Call setModuleLoader() first.");
  }

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
    console.error(`[registry] Failed to load component "${componentName}" from app "${appId}":`, err);
    return null;
  }
}

// Invalidate cache for an app (e.g. after hot-reload).
export function invalidateApp(appId: string): void {
  moduleCache.delete(appId);
}
