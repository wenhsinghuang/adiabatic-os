// Electron main process
// - Launches Bun runtime as child process
// - First-launch: copies template/ → ~/Adiabatic/
// - Opens renderer window

import { app, BrowserWindow, dialog, ipcMain, safeStorage, shell, type WebContents } from "electron";
import { spawn, type ChildProcess } from "child_process";
import { randomBytes } from "crypto";
import { existsSync, cpSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { createServer } from "net";
import { join, relative, sep } from "path";

const TEMPLATE = join(__dirname, "..", "..", "template");
const CORE_ENTRY = join(__dirname, "..", "..", "core", "src", "index.ts");
const PTY_HELPER = join(__dirname, "..", "..", "core", "src", "pty-helper.cjs");
const CORE_PORT_MIN = 32100;
const CORE_PORT_MAX = 32999;
const CORE_TOKEN = randomBytes(32).toString("base64url");
const BRIDGE_TOKEN = randomBytes(32).toString("base64url");

let bun: ChildProcess | null = null;
let workspace = "";
let corePort = 0;
let coreStartError: string | null = null;
let vaultId = "";
let vaultKey = "";
let nextTerminalId = 1;
const terminalSessions = new Map<string, { proc: ChildProcess; ownerWebContentsId: number }>();

interface AppSettings {
  workspacePath?: string;
}

interface WorkspaceSettings {
  corePort?: number;
  vaultId?: string;
}

function settingsPath(): string {
  return join(app.getPath("userData"), "settings.json");
}

function loadWorkspacePath(): string {
  const fallback = join(app.getPath("home"), "Adiabatic");
  try {
    const settings = JSON.parse(readFileSync(settingsPath(), "utf8")) as AppSettings;
    if (settings.workspacePath) return settings.workspacePath;
  } catch {}
  mkdirSync(app.getPath("userData"), { recursive: true });
  writeFileSync(settingsPath(), JSON.stringify({ workspacePath: fallback }, null, 2) + "\n", "utf8");
  return fallback;
}

function workspaceSettingsPath(targetWorkspace = workspace): string {
  return join(targetWorkspace, ".adiabatic", "settings.json");
}

function loadWorkspaceSettings(targetWorkspace = workspace): WorkspaceSettings {
  try {
    return JSON.parse(readFileSync(workspaceSettingsPath(targetWorkspace), "utf8")) as WorkspaceSettings;
  } catch {
    return {};
  }
}

function saveWorkspaceSettings(settings: WorkspaceSettings, targetWorkspace = workspace): void {
  const adiabaticDir = join(targetWorkspace, ".adiabatic");
  mkdirSync(adiabaticDir, { recursive: true });
  writeFileSync(workspaceSettingsPath(targetWorkspace), JSON.stringify(settings, null, 2) + "\n", "utf8");
}

function vaultRecordsPath(): string {
  return join(app.getPath("userData"), "vault-keys.json");
}

function loadVaultRecords(): Record<string, string> {
  try {
    return JSON.parse(readFileSync(vaultRecordsPath(), "utf8")) as Record<string, string>;
  } catch {
    return {};
  }
}

function saveVaultRecords(records: Record<string, string>): void {
  mkdirSync(app.getPath("userData"), { recursive: true });
  writeFileSync(vaultRecordsPath(), JSON.stringify(records, null, 2) + "\n", "utf8");
}

function loadOrCreateVaultKey(nextVaultId: string, opts: { allowCreate: boolean }): string {
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error("Electron safeStorage is unavailable; cannot unlock the workspace vault key");
  }
  const records = loadVaultRecords();
  const encrypted = records[nextVaultId];
  if (encrypted) {
    return safeStorage.decryptString(Buffer.from(encrypted, "base64"));
  }
  if (!opts.allowCreate) {
    throw new Error("Workspace vault is locked on this device. Import the recovery code to unlock it.");
  }
  const recoveryCode = randomBytes(32).toString("base64url");
  records[nextVaultId] = safeStorage.encryptString(recoveryCode).toString("base64");
  saveVaultRecords(records);
  return recoveryCode;
}

function importVaultKey(nextVaultId: string, recoveryCode: string): void {
  const decoded = Buffer.from(recoveryCode.trim(), "base64url");
  if (decoded.length !== 32) {
    throw new Error("Recovery code must decode to a 32-byte vault key");
  }
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error("Electron safeStorage is unavailable; cannot store the workspace vault key");
  }
  const records = loadVaultRecords();
  records[nextVaultId] = safeStorage.encryptString(recoveryCode.trim()).toString("base64");
  saveVaultRecords(records);
  vaultKey = recoveryCode.trim();
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
  // Built-in connectors are bundled catalog entries installed explicitly
  // through core (with a D0 connector.installed record), so they are excluded
  // from the template copy.
  cpSync(TEMPLATE, targetWorkspace, {
    recursive: true,
    filter: (src) => {
      const rel = relative(TEMPLATE, src);
      return rel !== "connectors" && !rel.startsWith(`connectors${sep}`);
    },
  });
}

async function ensureWorkspaceRuntimeSettings(opts?: { rotatePort?: boolean }): Promise<void> {
  const settings = loadWorkspaceSettings();
  const createdVaultId = !settings.vaultId;
  if (!settings.vaultId) {
    settings.vaultId = randomBytes(16).toString("base64url");
  }

  if (opts?.rotatePort || !settings.corePort) {
    settings.corePort = await chooseAvailableCorePort(settings.corePort);
  } else if (!(await isPortAvailable(settings.corePort))) {
    corePort = settings.corePort;
    throw new Error(
      `Core port ${settings.corePort} is already in use. Close the other app or explicitly rotate the workspace core port.`,
    );
  }

  saveWorkspaceSettings(settings);
  corePort = settings.corePort;
  vaultId = settings.vaultId;
  vaultKey = loadOrCreateVaultKey(vaultId, { allowCreate: createdVaultId });
}

async function chooseAvailableCorePort(exclude?: number): Promise<number> {
  const span = CORE_PORT_MAX - CORE_PORT_MIN + 1;
  const start = CORE_PORT_MIN + Math.floor(Math.random() * span);
  for (let i = 0; i < span; i++) {
    const port = CORE_PORT_MIN + ((start - CORE_PORT_MIN + i) % span);
    if (port === exclude) continue;
    if (await isPortAvailable(port)) return port;
  }
  throw new Error(`No free core port found in ${CORE_PORT_MIN}-${CORE_PORT_MAX}`);
}

function isPortAvailable(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer();
    server.once("error", () => resolve(false));
    server.once("listening", () => {
      server.close(() => resolve(true));
    });
    server.listen(port, "127.0.0.1");
  });
}

async function startCore(): Promise<void> {
  await ensureWorkspaceRuntimeSettings();
  console.log(`[electron] Starting Bun runtime on port ${corePort}...`);
  const child = spawn("bun", ["run", CORE_ENTRY, workspace], {
    stdio: "inherit",
    env: {
      ...process.env,
      PORT: String(corePort),
      ADIABATIC_CORE_TOKEN: CORE_TOKEN,
      ADIABATIC_BRIDGE_TOKEN: BRIDGE_TOKEN,
      ADIABATIC_VAULT_KEY: vaultKey,
    },
  });
  bun = child;
  coreStartError = null;
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
  disposeAllTerminals();
  await stopCore();
  workspace = normalized;
  saveWorkspacePath(workspace);
  ensureWorkspace(workspace);
  await startCore();
  await waitForCore();
  return workspace;
}

function createTerminal(sender: WebContents): { id: string } {
  const id = `terminal-${nextTerminalId++}`;
  const proc = spawn("node", [PTY_HELPER, workspace], {
    stdio: ["pipe", "pipe", "pipe"],
    env: {
      ...process.env,
      TERM: "xterm-256color",
      LANG: "en_US.UTF-8",
    },
  });

  terminalSessions.set(id, { proc, ownerWebContentsId: sender.id });

  proc.stdout?.on("data", (data) => {
    sender.send("terminal:data", { id, data: data.toString("utf8") });
  });
  proc.stderr?.on("data", (data) => {
    sender.send("terminal:data", { id, data: data.toString("utf8") });
  });
  proc.on("exit", (code) => {
    terminalSessions.delete(id);
    sender.send("terminal:exit", { id, code });
  });

  return { id };
}

function getTerminalForSender(id: string, sender: WebContents) {
  const session = terminalSessions.get(id);
  if (!session || session.ownerWebContentsId !== sender.id) return null;
  return session;
}

function disposeTerminal(id: string): void {
  const session = terminalSessions.get(id);
  if (!session) return;
  terminalSessions.delete(id);
  try { session.proc.kill(); } catch {}
}

function disposeTerminalsForWebContents(webContentsId: number): void {
  for (const [id, session] of terminalSessions) {
    if (session.ownerWebContentsId === webContentsId) {
      disposeTerminal(id);
    }
  }
}

function disposeAllTerminals(): void {
  for (const id of terminalSessions.keys()) {
    disposeTerminal(id);
  }
}

async function waitForCore(retries = 20, delay = 500): Promise<void> {
  for (let i = 0; i < retries; i++) {
    try {
      const res = await fetch(`${coreBaseUrl()}/api/apps`, {
        headers: { Authorization: `Bearer ${CORE_TOKEN}` },
      });
      if (!res.ok) throw new Error(`Core returned ${res.status}`);
      return;
    } catch {
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  throw new Error("Core server did not start in time");
}

function coreBaseUrl(): string {
  return `http://localhost:${corePort}`;
}

async function retryCore(): Promise<{ coreBaseUrl: string }> {
  await stopCore();
  await startCore();
  await waitForCore();
  return { coreBaseUrl: coreBaseUrl() };
}

async function rotateCorePort(): Promise<{ coreBaseUrl: string }> {
  await stopCore();
  await ensureWorkspaceRuntimeSettings({ rotatePort: true });
  await startCore();
  await waitForCore();
  return { coreBaseUrl: coreBaseUrl() };
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

  win.on("closed", () => {
    disposeTerminalsForWebContents(win.webContents.id);
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
  ipcMain.handle("auth:getCoreToken", () => CORE_TOKEN);
  ipcMain.handle("auth:getBridgeToken", () => BRIDGE_TOKEN);
  ipcMain.handle("auth:getRecoveryCode", () => vaultKey);
  ipcMain.handle("auth:importRecoveryCode", async (_event, recoveryCode: string) => {
    if (!vaultId) throw new Error("Workspace vault is not initialized");
    importVaultKey(vaultId, recoveryCode);
    await stopCore();
    await startCore();
    await waitForCore();
    return { coreBaseUrl: coreBaseUrl() };
  });
  ipcMain.handle("core:getBaseUrl", () => coreBaseUrl());
  ipcMain.handle("core:getStartError", () => coreStartError);
  ipcMain.handle("core:retry", () => retryCore());
  ipcMain.handle("core:rotatePort", () => rotateCorePort());
  ipcMain.handle("shell:openExternal", (_event, url: string) => shell.openExternal(url));
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
  ipcMain.handle("terminal:create", (event) => createTerminal(event.sender));
  ipcMain.on("terminal:input", (event, payload: { id: string; data: string }) => {
    const session = getTerminalForSender(payload.id, event.sender);
    if (!session?.proc.stdin?.writable) return;
    session.proc.stdin.write(payload.data);
  });
  ipcMain.on("terminal:resize", (event, payload: { id: string; cols: number; rows: number }) => {
    const session = getTerminalForSender(payload.id, event.sender);
    if (!session?.proc.stdin?.writable) return;
    session.proc.stdin.write("\x01" + JSON.stringify({ cols: payload.cols, rows: payload.rows }));
  });
  ipcMain.handle("terminal:dispose", (event, id: string) => {
    const session = getTerminalForSender(id, event.sender);
    if (!session) return { ok: true };
    disposeTerminal(id);
    return { ok: true };
  });
  ensureWorkspace();
  try {
    await startCore();
    await waitForCore();
  } catch (err) {
    coreStartError = err instanceof Error ? err.message : String(err);
    console.error(`[electron] Core failed to start: ${coreStartError}`);
  }
  await createWindow();
});

app.on("window-all-closed", () => {
  disposeAllTerminals();
  bun?.kill();
  app.quit();
});
