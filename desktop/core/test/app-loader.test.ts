import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { archiveApp, loadApps } from "../src/app-loader";
import { existsSync, mkdtempSync, rmSync, mkdirSync, writeFileSync } from "fs";
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

  test("supports src/App.tsx entry point", async () => {
    const appDir = join(appsDir, "modern");
    mkdirSync(join(appDir, "src"), { recursive: true });
    writeFileSync(
      join(appDir, "manifest.json"),
      JSON.stringify({ id: "modern", name: "Modern", permissions: { write: [] } }),
    );
    writeFileSync(join(appDir, "src/App.tsx"), "export default function App() { return null; }");

    const registry = await loadApps(appsDir);
    expect(registry.apps.get("modern")?.entryPoint).toContain("src/App.tsx");
  });

  test("prefers index.tsx when present", async () => {
    const appDir = join(appsDir, "simple");
    mkdirSync(join(appDir, "src"), { recursive: true });
    writeFileSync(
      join(appDir, "manifest.json"),
      JSON.stringify({ id: "simple", name: "Simple", permissions: { write: [] } }),
    );
    writeFileSync(join(appDir, "src/App.tsx"), "export default function App() { return null; }");
    writeFileSync(join(appDir, "index.tsx"), "export default function Index() { return null; }");

    const registry = await loadApps(appsDir);
    expect(registry.apps.get("simple")?.entryPoint).toContain("index.tsx");
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

  test("archiveApp moves the app out of apps/ and out of the registry", async () => {
    const appDir = join(appsDir, "retired");
    mkdirSync(appDir);
    writeFileSync(
      join(appDir, "manifest.json"),
      JSON.stringify({ id: "retired", name: "Retired", permissions: { write: [] } }),
    );
    writeFileSync(join(appDir, "index.tsx"), "export default function App() { return null; }");

    const archiveRoot = join(workspace, ".adiabatic", "archived-apps");
    const archivedTo = await archiveApp(appsDir, archiveRoot, "retired");

    expect(archivedTo).toBe(join(archiveRoot, "retired"));
    expect(existsSync(appDir)).toBe(false);
    expect(existsSync(join(archivedTo, "manifest.json"))).toBe(true);
    const registry = await loadApps(appsDir);
    expect(registry.apps.has("retired")).toBe(false);
  });

  test("archiveApp keeps prior archives on id collision", async () => {
    const archiveRoot = join(workspace, ".adiabatic", "archived-apps");

    function makeApp() {
      const appDir = join(appsDir, "dup");
      mkdirSync(appDir);
      writeFileSync(
        join(appDir, "manifest.json"),
        JSON.stringify({ id: "dup", name: "Dup", permissions: { write: [] } }),
      );
    }

    makeApp();
    const first = await archiveApp(appsDir, archiveRoot, "dup");
    makeApp();
    const second = await archiveApp(appsDir, archiveRoot, "dup");

    expect(first).toBe(join(archiveRoot, "dup"));
    expect(second).not.toBe(first);
    expect(existsSync(first)).toBe(true);
    expect(existsSync(second)).toBe(true);
  });

  test("archiveApp throws for a missing app", async () => {
    const archiveRoot = join(workspace, ".adiabatic", "archived-apps");
    await expect(archiveApp(appsDir, archiveRoot, "ghost")).rejects.toThrow("not found");
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
