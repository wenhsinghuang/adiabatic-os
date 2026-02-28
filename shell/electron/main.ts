// Electron main process
// - Launches Bun runtime as child process
// - First-launch: copies template/ → ~/Adiabatic/
// - Opens renderer window

import { app, BrowserWindow } from "electron";
import { spawn, type ChildProcess } from "child_process";
import { existsSync, cpSync } from "fs";
import { join } from "path";

const WORKSPACE = join(app.getPath("home"), "Adiabatic");
const TEMPLATE = join(__dirname, "..", "..", "template");
const CORE_ENTRY = join(__dirname, "..", "..", "core", "src", "index.ts");
const CORE_PORT = 3000;

let bun: ChildProcess | null = null;

function ensureWorkspace(): void {
  if (existsSync(WORKSPACE)) return;
  console.log(`[electron] First launch — copying template to ${WORKSPACE}`);
  cpSync(TEMPLATE, WORKSPACE, { recursive: true });
}

function startCore(): void {
  console.log(`[electron] Starting Bun runtime...`);
  bun = spawn("bun", ["run", CORE_ENTRY, WORKSPACE], {
    stdio: "inherit",
  });
  bun.on("exit", (code) => {
    console.log(`[electron] Bun exited with code ${code}`);
  });
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
  ensureWorkspace();
  startCore();
  await waitForCore();
  await createWindow();
});

app.on("window-all-closed", () => {
  bun?.kill();
  app.quit();
});
