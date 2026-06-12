import { randomUUID } from "crypto";
import { cp, mkdir, readdir, rename, rm, stat } from "fs/promises";
import { isAbsolute, join, relative, resolve } from "path";
import { loadConnectorManifest, validateConnectorId } from "./manifest";
import { hashConnectorPackage } from "./registry";
import type { ConnectorManifest } from "./types";
import type { ConnectorSupervisor } from "./supervisor";
import type { Guard } from "../guard";

export interface InstalledConnector {
  manifest: ConnectorManifest;
  dir: string;
}

export interface InstallConnectorOptions {
  sourceDir: string;
  workspacePath: string;
  connectorId?: string;
  overwrite?: boolean;
}

export interface RegisterWorkspaceConnectorsOptions {
  skipInvalid?: boolean;
  onError?: (connectorDir: string, error: unknown) => void;
}

export function workspaceConnectorsDir(workspacePath: string): string {
  return resolve(workspacePath, "connectors");
}

export function resolveWorkspaceConnectorDir(
  workspacePath: string,
  connectorId: string,
): string {
  validateConnectorId(connectorId);
  const root = workspaceConnectorsDir(workspacePath);
  const target = resolve(root, connectorId);
  const rel = relative(root, target);
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) {
    throw new Error(`Connector directory must stay inside workspace connectors/: ${connectorId}`);
  }
  return target;
}

export async function installConnector(
  opts: InstallConnectorOptions,
): Promise<InstalledConnector> {
  const sourceDir = resolve(opts.sourceDir);
  const manifest = await loadConnectorManifest(sourceDir);
  if (opts.connectorId && opts.connectorId !== manifest.id) {
    throw new Error(`Connector manifest id "${manifest.id}" does not match requested id "${opts.connectorId}"`);
  }

  const connectorsDir = workspaceConnectorsDir(opts.workspacePath);
  const targetDir = resolveWorkspaceConnectorDir(opts.workspacePath, manifest.id);
  await mkdir(connectorsDir, { recursive: true });

  if (opts.overwrite) {
    await rm(targetDir, { recursive: true, force: true });
  } else if (await pathExists(targetDir)) {
    throw new Error(`Connector already installed: ${manifest.id}`);
  }

  // Stage then rename so a crash mid-copy never leaves a half-written
  // package squatting on the connector's directory.
  const stagingDir = join(connectorsDir, `.staging-${manifest.id}-${randomUUID()}`);
  try {
    await cp(sourceDir, stagingDir, { recursive: true });
    await rename(stagingDir, targetDir);
  } catch (err) {
    await rm(stagingDir, { recursive: true, force: true });
    throw err;
  }

  return {
    manifest,
    dir: targetDir,
  };
}

export async function materializeBuiltInConnector(
  opts: InstallConnectorOptions,
): Promise<InstalledConnector> {
  return installConnector(opts);
}

export async function removeInstalledConnector(
  workspacePath: string,
  connectorId: string,
): Promise<boolean> {
  const targetDir = resolveWorkspaceConnectorDir(workspacePath, connectorId);
  if (!(await pathExists(targetDir))) return false;
  await rm(targetDir, { recursive: true, force: true });
  return true;
}

export async function listInstalledConnectorDirs(workspacePath: string): Promise<string[]> {
  const connectorsDir = workspaceConnectorsDir(workspacePath);
  let entries;
  try {
    entries = await readdir(connectorsDir, { withFileTypes: true });
  } catch (err) {
    if (isNotFoundError(err)) return [];
    throw err;
  }

  return entries
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
    .map((entry) => join(connectorsDir, entry.name))
    .sort();
}

// Built-ins are bundled catalog entries: packages shipped with the app that
// can be installed without a download. Listing them never copies anything —
// installation is always an explicit user action through the same install
// flow as any other connector package.
export async function listAvailableBuiltIns(
  builtinsDir: string,
  onError?: (connectorDir: string, error: unknown) => void,
): Promise<InstalledConnector[]> {
  let entries;
  try {
    entries = await readdir(builtinsDir, { withFileTypes: true });
  } catch (err) {
    if (isNotFoundError(err)) return [];
    throw err;
  }

  const available: InstalledConnector[] = [];
  for (const entry of entries.filter((e) => e.isDirectory() && !e.name.startsWith(".")).sort((a, b) => a.name.localeCompare(b.name))) {
    const dir = join(builtinsDir, entry.name);
    try {
      const manifest = await loadConnectorManifest(dir);
      if (manifest.id !== entry.name) {
        throw new Error(`Connector manifest id "${manifest.id}" must match folder "${entry.name}"`);
      }
      available.push({ manifest, dir });
    } catch (err) {
      if (!onError) throw err;
      onError(dir, err);
    }
  }
  return available;
}

export interface InstallConnectorFromSourceOptions extends InstallConnectorOptions {
  guard: Guard;
}

// The one install path: copies the package into the workspace and records the
// action in D0 as connector.installed. Reinstalling after a removal emits a
// fresh event — D0 keeps the full install/remove history.
export async function installConnectorFromSource(
  opts: InstallConnectorFromSourceOptions,
): Promise<InstalledConnector> {
  const installed = await installConnector(opts);
  opts.guard.writeEvent({
    type: "connector.installed",
    startedAt: Date.now(),
    payload: {
      connector_id: installed.manifest.id,
      package_hash: await hashConnectorPackage(installed.dir),
    },
  });
  return installed;
}

export async function registerWorkspaceConnectors(
  supervisor: ConnectorSupervisor,
  workspacePath: string,
  opts: RegisterWorkspaceConnectorsOptions = {},
): Promise<ConnectorManifest[]> {
  const manifests: ConnectorManifest[] = [];
  for (const connectorDir of await listInstalledConnectorDirs(workspacePath)) {
    try {
      const manifest = await supervisor.registerDirectory(connectorDir);
      supervisor.ensureFirstIntegration(manifest.id);
      manifests.push(manifest);
    } catch (err) {
      if (!opts.skipInvalid) throw err;
      opts.onError?.(connectorDir, err);
    }
  }
  return manifests;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (err) {
    if (isNotFoundError(err)) return false;
    throw err;
  }
}

function isNotFoundError(err: unknown): boolean {
  return Boolean(err) && typeof err === "object" && (err as { code?: string }).code === "ENOENT";
}
