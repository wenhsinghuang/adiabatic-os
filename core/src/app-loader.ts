import { readdir, readFile } from "fs/promises";
import { join } from "path";

// App Loader — scans apps/ directory, reads manifests, builds registry.

export interface AppManifest {
  id: string;
  name: string;
  permissions: {
    write: string[]; // D2 tables this app can write to
  };
  components: string[]; // exported React component names (e.g. ["FocusChart", "FocusStats"])
}

export interface LoadedApp {
  manifest: AppManifest;
  dir: string;
  entryPoint: string; // path to index.tsx
}

export interface AppRegistry {
  apps: Map<string, LoadedApp>;
  getPermissions(appId: string): string[];
  hasWritePermission(appId: string, table: string): boolean;
  resolveComponent(componentName: string): { appId: string; entryPoint: string } | null;
}

export async function loadApps(appsDir: string): Promise<AppRegistry> {
  const apps = new Map<string, LoadedApp>();

  let entries;
  try {
    entries = await readdir(appsDir, { withFileTypes: true });
  } catch {
    // apps/ doesn't exist yet — that's fine
    return createRegistry(apps);
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;

    const appDir = join(appsDir, entry.name);
    const manifestPath = join(appDir, "manifest.json");

    try {
      const raw = await readFile(manifestPath, "utf8");
      const manifest = JSON.parse(raw) as AppManifest;

      // Validate
      if (!manifest.id || !manifest.name) {
        console.warn(`[app-loader] Skipping ${entry.name}: missing id or name in manifest`);
        continue;
      }
      if (manifest.id !== entry.name) {
        console.warn(`[app-loader] Skipping ${entry.name}: manifest id "${manifest.id}" does not match directory name`);
        continue;
      }

      manifest.permissions ??= { write: [] };
      manifest.permissions.write ??= [];
      manifest.components ??= [];

      apps.set(manifest.id, {
        manifest,
        dir: appDir,
        entryPoint: join(appDir, "index.tsx"),
      });
    } catch {
      console.warn(`[app-loader] Skipping ${entry.name}: could not read manifest.json`);
    }
  }

  return createRegistry(apps);
}

function createRegistry(apps: Map<string, LoadedApp>): AppRegistry {
  // Build reverse index: componentName → appId
  const componentIndex = new Map<string, string>();
  for (const [appId, app] of apps) {
    for (const comp of app.manifest.components) {
      componentIndex.set(comp, appId);
    }
  }

  return {
    apps,
    getPermissions(appId: string): string[] {
      return apps.get(appId)?.manifest.permissions.write ?? [];
    },
    hasWritePermission(appId: string, table: string): boolean {
      const perms = apps.get(appId)?.manifest.permissions.write ?? [];
      return perms.includes(table);
    },
    resolveComponent(componentName: string): { appId: string; entryPoint: string } | null {
      const appId = componentIndex.get(componentName);
      if (!appId) return null;
      const app = apps.get(appId);
      if (!app) return null;
      return { appId, entryPoint: app.entryPoint };
    },
  };
}
