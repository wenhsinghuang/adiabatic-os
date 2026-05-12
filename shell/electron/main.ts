// Electron main process
// - Launches Bun runtime as child process
// - First-launch: copies template/ → ~/Adiabatic/
// - Opens renderer window

import { app, BrowserWindow, dialog, ipcMain } from "electron";
import { spawn, type ChildProcess } from "child_process";
import { existsSync, cpSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";

const TEMPLATE = join(__dirname, "..", "..", "template");
const CORE_ENTRY = join(__dirname, "..", "..", "core", "src", "index.ts");
const CORE_PORT = 3000;

let bun: ChildProcess | null = null;
let workspace = "";

function settingsPath(): string {
  return join(app.getPath("userData"), "settings.json");
}

function loadWorkspacePath(): string {
  const fallback = join(app.getPath("home"), "Adiabatic");
  try {
    const settings = JSON.parse(readFileSync(settingsPath(), "utf8")) as { workspacePath?: string };
    if (settings.workspacePath) return settings.workspacePath;
  } catch {}
  mkdirSync(app.getPath("userData"), { recursive: true });
  writeFileSync(settingsPath(), JSON.stringify({ workspacePath: fallback }, null, 2) + "\n", "utf8");
  return fallback;
}

function saveWorkspacePath(nextWorkspace: string): void {
  mkdirSync(app.getPath("userData"), { recursive: true });
  writeFileSync(
    settingsPath(),
    JSON.stringify({ workspacePath: nextWorkspace }, null, 2) + "\n",
    "utf8",
  );
}

function ensureWorkspace(targetWorkspace = workspace): void {
  if (existsSync(targetWorkspace)) return;
  console.log(`[electron] First launch — copying template to ${targetWorkspace}`);
  cpSync(TEMPLATE, targetWorkspace, { recursive: true });
}

function startCore(): void {
  console.log(`[electron] Starting Bun runtime...`);
  const child = spawn("bun", ["run", CORE_ENTRY, workspace], {
    stdio: "inherit",
  });
  bun = child;
  child.on("exit", (code) => {
    console.log(`[electron] Bun exited with code ${code}`);
    if (bun === child) bun = null;
  });
}

async function stopCore(): Promise<void> {
  if (!bun) return;
  const child = bun;
  bun = null;
  await new Promise<void>((resolve) => {
    const timeout = setTimeout(resolve, 1500);
    child.once("exit", () => {
      clearTimeout(timeout);
      resolve();
    });
    child.kill();
  });
}

async function switchWorkspace(nextWorkspace: string): Promise<string> {
  const normalized = nextWorkspace.trim();
  if (!normalized) {
    throw new Error("Workspace path is required");
  }
  if (normalized === workspace) return workspace;
  await stopCore();
  workspace = normalized;
  saveWorkspacePath(workspace);
  ensureWorkspace(workspace);
  startCore();
  await waitForCore();
  return workspace;
}

async function waitForCore(retries = 20, delay = 500): Promise<void> {
  for (let i = 0; i < retries; i++) {
    try {
      await fetch(`http://localhost:${CORE_PORT}/api/apps`);
      return;
    } catch {
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  throw new Error("Core server did not start in time");
}

async function createWindow(): Promise<void> {
  const win = new BrowserWindow({
    width: 1200,
    height: 800,
    title: "Adiabatic",
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: join(__dirname, "preload.cjs"),
    },
  });

  // Dev mode: load Vite dev server. Prod: load built files.
  if (process.env.NODE_ENV === "development") {
    await win.loadURL("http://localhost:5173");
  } else {
    await win.loadFile(join(__dirname, "..", "dist", "index.html"));
  }
}

app.whenReady().then(async () => {
  workspace = loadWorkspacePath();
  ipcMain.handle("workspace:get", () => workspace);
  ipcMain.handle("workspace:set", async (_event, nextWorkspace: string) => {
    const path = await switchWorkspace(nextWorkspace);
    return { path };
  });
  ipcMain.handle("workspace:choose", async () => {
    const result = await dialog.showOpenDialog({
      title: "Choose Adiabatic workspace",
      properties: ["openDirectory", "createDirectory"],
    });
    if (result.canceled || result.filePaths.length === 0) {
      return { path: null };
    }
    const path = await switchWorkspace(result.filePaths[0]);
    return { path };
  });
  ensureWorkspace();
  startCore();
  await waitForCore();
  await createWindow();
});

app.on("window-all-closed", () => {
  bun?.kill();
  app.quit();
});
