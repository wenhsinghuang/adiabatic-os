import { readFile, readdir } from "fs/promises";
import { join } from "path";
import type {
  ConnectorAuthSpec,
  ConnectorIntegrationMode,
  ConnectorManifest,
  ConnectorPlatform,
  ConnectorPlatformsSpec,
  ConnectorRuntimeMode,
} from "./types";
import { validateConnectorSchedule } from "./schedule";

const CONNECTOR_ID_PATTERN = /^[a-z0-9][a-z0-9-]*$/;
const INTEGRATION_KEY_PATTERN = /^[a-z0-9][a-z0-9-]*$/;
const CONNECTOR_MODES = new Set<ConnectorRuntimeMode>(["watch", "poll", "import"]);
const INTEGRATION_MODES = new Set<ConnectorIntegrationMode>(["singleton", "multiple"]);
const CONNECTOR_PLATFORMS = new Set<ConnectorPlatform>([
  "darwin",
  "linux",
  "windows",
  "ios",
  "android",
  "cloud",
]);
const AUTH_TYPES = new Set(["none", "apiKey", "oauth2"]);
const OAUTH_TOKEN_ENDPOINT_AUTH_METHODS = new Set([
  "none",
  "client_secret_basic",
  "client_secret_post",
]);

export function validateConnectorId(id: string): void {
  if (!CONNECTOR_ID_PATTERN.test(id)) {
    throw new Error(`Invalid connector id: ${id}`);
  }
}

export function validateIntegrationKey(key: string): void {
  if (!INTEGRATION_KEY_PATTERN.test(key)) {
    throw new Error(`Invalid connector integration key: ${key}`);
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
  if ("schedule" in manifest.runtime) {
    throw new Error(`Connector ${manifest.id} runtime.schedule is no longer supported; use runtime.defaultSchedule`);
  }
  if (manifest.runtime.mode !== "poll" && manifest.runtime.defaultSchedule) {
    throw new Error(`Connector ${manifest.id} defaultSchedule is only valid for poll runtime`);
  }
  if (manifest.runtime.defaultSchedule) {
    validateConnectorSchedule(manifest.runtime.defaultSchedule);
  }

  // No default: integrations.mode is a source-scope decision the author must make.
  // A device-scoped connector silently defaulted to singleton corrupts source
  // provenance across devices.
  const integrations = manifest.integrations;
  if (!integrations || integrations.mode === undefined) {
    throw new Error(`Connector ${manifest.id} requires an explicit integrations.mode (singleton or multiple)`);
  }
  if (!INTEGRATION_MODES.has(integrations.mode)) {
    throw new Error(`Connector ${manifest.id} has invalid integrations mode`);
  }

  const platforms = validatePlatformsSpec(manifest.id, manifest.platforms);
  validateAuthSpec(manifest.id, manifest.auth ?? { type: "none" });
  return {
    ...manifest,
    integrations,
    auth: manifest.auth ?? { type: "none" },
    platforms,
    capabilities: manifest.capabilities ?? [],
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
  const platforms = manifest.platforms ?? {};
  const declared = Object.keys(platforms);
  return declared.length === 0 || platform in platforms;
}

export function activePlatformRequirements(
  manifest: ConnectorManifest,
  platform: ConnectorPlatform,
): string[] {
  return manifest.platforms?.[platform]?.requirements ?? [];
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
  if (auth.type === "oauth2") {
    // YAML/JSON is untyped at parse time, so validate shapes at runtime. The
    // broker is a generic executor consuming standard OAuth client metadata;
    // endpoints are required https URLs (an http token endpoint would send
    // tokens in cleartext).
    for (const field of ["authorizationEndpoint", "tokenEndpoint"] as const) {
      const value = auth[field];
      if (typeof value !== "string" || !value) {
        throw new Error(`Connector ${connectorId} oauth2 auth requires ${field} (https URL)`);
      }
      let url: URL;
      try {
        url = new URL(value);
      } catch {
        throw new Error(`Connector ${connectorId} oauth2 ${field} is not a valid URL: ${value}`);
      }
      if (url.protocol !== "https:") {
        throw new Error(`Connector ${connectorId} oauth2 ${field} must be https: ${value}`);
      }
    }
    // clientId is the OAuth app's public client identifier and lives in the
    // manifest like any other config; the catalog is trust-only, not a config
    // source, so there is no fallback for it.
    if (typeof auth.clientId !== "string" || !auth.clientId) {
      throw new Error(`Connector ${connectorId} oauth2 auth requires clientId`);
    }
    if (auth.scope !== undefined &&
      (!Array.isArray(auth.scope) || auth.scope.some((s) => typeof s !== "string"))) {
      throw new Error(`Connector ${connectorId} oauth2 scope must be an array of strings`);
    }
    if (auth.tokenEndpointAuthMethod !== undefined &&
      !OAUTH_TOKEN_ENDPOINT_AUTH_METHODS.has(auth.tokenEndpointAuthMethod)) {
      throw new Error(`Connector ${connectorId} oauth2 tokenEndpointAuthMethod is invalid: ${auth.tokenEndpointAuthMethod}`);
    }
  }
}

function validatePlatformsSpec(
  connectorId: string,
  platforms: ConnectorPlatformsSpec | undefined,
): ConnectorPlatformsSpec {
  if (platforms === undefined) return {};
  if (Array.isArray(platforms) || typeof platforms !== "object" || platforms === null) {
    throw new Error(`Connector ${connectorId} platforms must be a structured object`);
  }

  const normalized: ConnectorPlatformsSpec = {};
  for (const [platform, spec] of Object.entries(platforms)) {
    if (!CONNECTOR_PLATFORMS.has(platform as ConnectorPlatform)) {
      throw new Error(`Connector ${connectorId} has invalid platform: ${platform}`);
    }
    if (spec === null || typeof spec !== "object" || Array.isArray(spec)) {
      throw new Error(`Connector ${connectorId} platform ${platform} must be an object`);
    }
    const requirements = spec.requirements ?? [];
    if (!Array.isArray(requirements) || !requirements.every((value) => typeof value === "string" && value.length > 0)) {
      throw new Error(`Connector ${connectorId} platform ${platform} requirements must be strings`);
    }
    normalized[platform as ConnectorPlatform] = { requirements };
  }
  return normalized;
}

function parseSimpleYaml(text: string): unknown {
  const lines = text
    .split(/\r?\n/)
    .map((rawLine) => ({
      raw: rawLine,
      withoutComment: rawLine.replace(/\s+#.*$/, ""),
    }))
    .filter((line) => line.withoutComment.trim())
    .map((line) => ({
      raw: line.raw,
      indent: line.withoutComment.match(/^ */)?.[0].length ?? 0,
      text: line.withoutComment.trim(),
    }));

  function parseBlock(index: number, indent: number): { value: unknown; index: number } {
    if (index >= lines.length) return { value: {}, index };
    if (lines[index].indent < indent) return { value: {}, index };
    if (lines[index].indent > indent) {
      throw new Error(`Unsupported connector YAML indentation: ${lines[index].raw}`);
    }

    if (lines[index].text.startsWith("- ")) {
      const array: unknown[] = [];
      while (index < lines.length && lines[index].indent === indent && lines[index].text.startsWith("- ")) {
        const item = lines[index].text.slice(2).trim();
        index += 1;
        if (!item) {
          const nested = parseBlock(index, indent + 2);
          array.push(nested.value);
          index = nested.index;
        } else {
          array.push(parseYamlScalar(item));
        }
      }
      return { value: array, index };
    }

    const object: Record<string, unknown> = {};
    while (index < lines.length && lines[index].indent === indent && !lines[index].text.startsWith("- ")) {
      const match = lines[index].text.match(/^([^:]+):(.*)$/);
      if (!match) throw new Error(`Invalid connector YAML line: ${lines[index].raw}`);
      const key = match[1].trim();
      const value = match[2].trim();
      index += 1;
      if (!value) {
        const nested = parseBlock(index, indent + 2);
        object[key] = nested.value;
        index = nested.index;
      } else {
        object[key] = parseYamlScalar(value);
      }
    }
    return { value: object, index };
  }

  return parseBlock(0, 0).value;
}

function parseYamlScalar(value: string): unknown {
  const unquoted = value.replace(/^["']|["']$/g, "");
  if (unquoted === "{}") return {};
  if (unquoted === "[]") return [];
  if (unquoted === "true") return true;
  if (unquoted === "false") return false;
  if (/^-?\d+(\.\d+)?$/.test(unquoted)) return Number(unquoted);
  return unquoted;
}
