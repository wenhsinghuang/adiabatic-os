import { readFile, readdir } from "fs/promises";
import { join } from "path";
import type {
  ConnectorAuthSpec,
  ConnectorManifest,
  ConnectorPlatform,
  ConnectorRuntimeMode,
} from "./types";

const CONNECTOR_ID_PATTERN = /^[a-z0-9][a-z0-9-]*$/;
const CONNECTOR_MODES = new Set<ConnectorRuntimeMode>(["watch", "poll", "import"]);
const CONNECTOR_PLATFORMS = new Set<ConnectorPlatform>([
  "darwin",
  "linux",
  "windows",
  "ios",
  "android",
  "cloud",
]);
const AUTH_TYPES = new Set(["none", "apiKey", "oauth2", "localPermission"]);

export function validateConnectorId(id: string): void {
  if (!CONNECTOR_ID_PATTERN.test(id)) {
    throw new Error(`Invalid connector id: ${id}`);
  }
}

export function validateConnectorManifest(manifest: ConnectorManifest): ConnectorManifest {
  validateConnectorId(manifest.id);
  if (!manifest.name || manifest.name.trim() !== manifest.name) {
    throw new Error(`Connector ${manifest.id} requires a valid name`);
  }
  if (!manifest.entry || manifest.entry.trim() !== manifest.entry) {
    throw new Error(`Connector ${manifest.id} requires an entry`);
  }
  if (!manifest.runtime || !CONNECTOR_MODES.has(manifest.runtime.mode)) {
    throw new Error(`Connector ${manifest.id} has invalid runtime mode`);
  }
  if (manifest.runtime.mode !== "poll" && manifest.runtime.schedule) {
    throw new Error(`Connector ${manifest.id} schedule is only valid for poll runtime`);
  }
  for (const platform of manifest.platforms ?? []) {
    if (!CONNECTOR_PLATFORMS.has(platform)) {
      throw new Error(`Connector ${manifest.id} has invalid platform: ${platform}`);
    }
  }
  validateAuthSpec(manifest.id, manifest.auth ?? { type: "none" });
  return {
    ...manifest,
    auth: manifest.auth ?? { type: "none" },
    platforms: manifest.platforms ?? [],
    capabilities: manifest.capabilities ?? [],
    events: manifest.events ?? [],
  };
}

export function currentConnectorPlatform(): ConnectorPlatform {
  switch (process.platform) {
    case "darwin":
      return "darwin";
    case "linux":
      return "linux";
    case "win32":
      return "windows";
    default:
      return "linux";
  }
}

export function isPlatformSupported(
  manifest: ConnectorManifest,
  platform: ConnectorPlatform,
): boolean {
  const platforms = manifest.platforms ?? [];
  return platforms.length === 0 || platforms.includes(platform);
}

export async function loadConnectorManifest(connectorDir: string): Promise<ConnectorManifest> {
  const entries = await readdir(connectorDir);
  const filename = ["connector.yaml", "connector.yml", "connector.json"].find((candidate) =>
    entries.includes(candidate)
  );
  if (!filename) {
    throw new Error(`Connector manifest not found in ${connectorDir}`);
  }

  const text = await readFile(join(connectorDir, filename), "utf8");
  const raw = filename.endsWith(".json") ? JSON.parse(text) : parseSimpleYaml(text);
  return validateConnectorManifest(raw as ConnectorManifest);
}

function validateAuthSpec(connectorId: string, auth: ConnectorAuthSpec): void {
  if (!AUTH_TYPES.has(auth.type)) {
    throw new Error(`Connector ${connectorId} has invalid auth type: ${(auth as { type?: string }).type}`);
  }
  if (auth.type === "oauth2" && !auth.provider) {
    throw new Error(`Connector ${connectorId} oauth2 auth requires provider`);
  }
}

function parseSimpleYaml(text: string): unknown {
  const root: Record<string, unknown> = {};
  const lines = text.split(/\r?\n/);
  let currentObjectKey: string | null = null;
  let currentArrayKey: string | null = null;
  let currentArrayParent: Record<string, unknown> = root;

  for (const rawLine of lines) {
    const withoutComment = rawLine.replace(/\s+#.*$/, "");
    if (!withoutComment.trim()) continue;

    const indent = withoutComment.match(/^ */)?.[0].length ?? 0;
    const line = withoutComment.trim();

    if (indent === 0) {
      currentObjectKey = null;
      currentArrayKey = null;
      currentArrayParent = root;

      const match = line.match(/^([^:]+):(.*)$/);
      if (!match) throw new Error(`Invalid connector YAML line: ${rawLine}`);
      const key = match[1].trim();
      const value = match[2].trim();
      if (!value) {
        root[key] = {};
        currentObjectKey = key;
      } else {
        root[key] = parseYamlScalar(value);
      }
      continue;
    }

    if (indent === 2 && currentObjectKey) {
      const parent = root[currentObjectKey] as Record<string, unknown>;
      if (line.startsWith("- ")) {
        if (!Array.isArray(root[currentObjectKey])) root[currentObjectKey] = [];
        (root[currentObjectKey] as unknown[]).push(parseYamlScalar(line.slice(2).trim()));
        continue;
      }

      const match = line.match(/^([^:]+):(.*)$/);
      if (!match) throw new Error(`Invalid connector YAML line: ${rawLine}`);
      const key = match[1].trim();
      const value = match[2].trim();
      if (!value) {
        parent[key] = [];
        currentArrayKey = key;
        currentArrayParent = parent;
      } else {
        parent[key] = parseYamlScalar(value);
      }
      continue;
    }

    if (indent === 2 && line.startsWith("- ")) {
      if (!currentArrayKey) {
        const lastArrayKey = Object.keys(root).find((key) => Array.isArray(root[key]));
        if (!lastArrayKey) throw new Error(`Invalid connector YAML line: ${rawLine}`);
        currentArrayKey = lastArrayKey;
        currentArrayParent = root;
      }
      (currentArrayParent[currentArrayKey] as unknown[]).push(parseYamlScalar(line.slice(2).trim()));
      continue;
    }

    if (indent === 4 && currentArrayKey) {
      if (!line.startsWith("- ")) throw new Error(`Invalid connector YAML line: ${rawLine}`);
      (currentArrayParent[currentArrayKey] as unknown[]).push(parseYamlScalar(line.slice(2).trim()));
      continue;
    }

    throw new Error(`Unsupported connector YAML shape: ${rawLine}`);
  }

  return root;
}

function parseYamlScalar(value: string): unknown {
  const unquoted = value.replace(/^["']|["']$/g, "");
  if (unquoted === "true") return true;
  if (unquoted === "false") return false;
  if (/^-?\d+(\.\d+)?$/.test(unquoted)) return Number(unquoted);
  return unquoted;
}

