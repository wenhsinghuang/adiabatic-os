import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { loadApps } from "../src/app-loader";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

describe("App Loader", () => {
  let workspace: string;
  let appsDir: string;

  beforeEach(() => {
    workspace = mkdtempSync(join(tmpdir(), "adiabatic-test-"));
    appsDir = join(workspace, "apps");
    mkdirSync(appsDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(workspace, { recursive: true, force: true });
  });

  test("loads app with valid manifest", async () => {
    const appDir = join(appsDir, "test-app");
    mkdirSync(appDir);
    writeFileSync(
      join(appDir, "manifest.json"),
      JSON.stringify({ id: "test-app", name: "Test App", permissions: { write: ["my_table"] } })
    );
    writeFileSync(join(appDir, "index.tsx"), "export function TestWidget() { return null; }");

    const registry = await loadApps(appsDir);
    expect(registry.apps.size).toBe(1);
    expect(registry.apps.get("test-app")).toBeTruthy();
    expect(registry.getPermissions("test-app")).toEqual(["my_table"]);
  });

  test("hasWritePermission checks correctly", async () => {
    const appDir = join(appsDir, "focus");
    mkdirSync(appDir);
    writeFileSync(
      join(appDir, "manifest.json"),
      JSON.stringify({ id: "focus", name: "Focus", permissions: { write: ["focus_sessions"] } })
    );

    const registry = await loadApps(appsDir);
    expect(registry.hasWritePermission("focus", "focus_sessions")).toBe(true);
    expect(registry.hasWritePermission("focus", "other_table")).toBe(false);
    expect(registry.hasWritePermission("unknown-app", "focus_sessions")).toBe(false);
  });

  test("skips app with mismatched manifest id", async () => {
    const appDir = join(appsDir, "my-app");
    mkdirSync(appDir);
    writeFileSync(
      join(appDir, "manifest.json"),
      JSON.stringify({ id: "wrong-id", name: "Wrong", permissions: { write: [] } })
    );

    const registry = await loadApps(appsDir);
    expect(registry.apps.size).toBe(0);
  });

  test("skips directory without manifest", async () => {
    mkdirSync(join(appsDir, "no-manifest"));
    const registry = await loadApps(appsDir);
    expect(registry.apps.size).toBe(0);
  });

  test("handles missing apps/ directory", async () => {
    const registry = await loadApps(join(workspace, "nonexistent"));
    expect(registry.apps.size).toBe(0);
  });

  test("resolves component to app", async () => {
    const appDir = join(appsDir, "focus");
    mkdirSync(appDir);
    writeFileSync(
      join(appDir, "manifest.json"),
      JSON.stringify({
        id: "focus",
        name: "Focus",
        permissions: { write: [] },
        components: ["FocusChart", "FocusStats"],
      }),
    );
    writeFileSync(join(appDir, "index.tsx"), "export function FocusChart() {}");

    const registry = await loadApps(appsDir);
    const resolved = registry.resolveComponent("FocusChart");
    expect(resolved).toBeTruthy();
    expect(resolved!.appId).toBe("focus");
    expect(resolved!.entryPoint).toContain("index.tsx");

    expect(registry.resolveComponent("FocusStats")?.appId).toBe("focus");
    expect(registry.resolveComponent("Unknown")).toBeNull();
  });

  test("defaults components to empty array when missing", async () => {
    const appDir = join(appsDir, "legacy");
    mkdirSync(appDir);
    writeFileSync(
      join(appDir, "manifest.json"),
      JSON.stringify({ id: "legacy", name: "Legacy", permissions: { write: [] } }),
    );

    const registry = await loadApps(appsDir);
    const app = registry.apps.get("legacy");
    expect(app?.manifest.components).toEqual([]);
  });
});
