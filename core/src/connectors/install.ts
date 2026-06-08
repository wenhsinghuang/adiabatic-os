import { cp, mkdir, readdir, rm, stat } from "fs/promises";
import { isAbsolute, join, relative, resolve } from "path";
import { loadConnectorManifest, validateConnectorId } from "./manifest";
import type { ConnectorManifest } from "./types";
import type { ConnectorSupervisor } from "./supervisor";

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

  await cp(sourceDir, targetDir, {
    recursive: true,
    errorOnExist: true,
    force: false,
  });

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
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(connectorsDir, entry.name))
    .sort();
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
