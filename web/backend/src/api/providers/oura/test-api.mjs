#!/usr/bin/env node

import { spawn } from "node:child_process";
import crypto from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import http from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const OURA_API_BASE_URL = "https://api.ouraring.com";
const OURA_AUTHORIZATION_ENDPOINT = "https://cloud.ouraring.com/oauth/authorize";
const OURA_TOKEN_ENDPOINT = "https://api.ouraring.com/oauth/token";
const DEFAULT_REDIRECT_URI = "http://localhost:32100/oauth/callback";
const DEFAULT_SCOPE = [
  "email",
  "personal",
  "daily",
  "heartrate",
  "tag",
  "workout",
  "session",
  "spo2",
  "ring_configuration",
  "stress",
  "heart_health",
].join(" ");
const OAUTH_WAIT_MS = 5 * 60 * 1000;
const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const DEFAULT_CACHE_DIR = join(SCRIPT_DIR, ".test-api-cache");

const STREAMS = {
  ring_battery_level: {
    path: "/v2/usercollection/ring_battery_level",
    timeParams: "datetime",
  },
  heartrate: {
    path: "/v2/usercollection/heartrate",
    timeParams: "datetime",
  },
  daily_activity: {
    path: "/v2/usercollection/daily_activity",
    timeParams: "date",
  },
  daily_sleep: {
    path: "/v2/usercollection/daily_sleep",
    timeParams: "date",
  },
  daily_readiness: {
    path: "/v2/usercollection/daily_readiness",
    timeParams: "date",
  },
};

const RATE_LIMIT_HEADERS = [
  "retry-after",
  "x-ratelimit-limit",
  "x-ratelimit-remaining",
  "x-ratelimit-reset",
  "x-ratelimit-tier",
];

function usage() {
  console.error(`Usage:
  doppler run -- node web/backend/src/api/providers/oura/test-api.mjs battery [--latest] [--days 1] [--limit 5]
  doppler run -- node web/backend/src/api/providers/oura/test-api.mjs stream <streamId> [--latest] [--days 1]

Required env when OURA_ACCESS_TOKEN is not set:
  OURA_CLIENT_ID
  OURA_CLIENT_SECRET

Optional env:
  OURA_ACCESS_TOKEN     Skip OAuth and use this token directly.
  OURA_REDIRECT_URI    OAuth callback URI. Default: ${DEFAULT_REDIRECT_URI}
  OURA_SCOPE           OAuth scope. Default: ${DEFAULT_SCOPE}

Options:
  --latest              Request latest=true.
  --days <n>            Request the last n days. Defaults to 1 for range probes.
  --start <value>       Explicit start date/datetime.
  --end <value>         Explicit end date/datetime.
  --next-token <value>  Request the next page.
  --fields <csv>        Pass Oura fields query parameter.
  --limit <n>           Number of samples to print. Default: 5.
  --low <n>             Battery low threshold. Default: 20.
  --charged <n>         Battery charged threshold. Default: 95.
  --redirect-uri <uri>  Override OURA_REDIRECT_URI for this run.
  --scope <scope>       Override OURA_SCOPE for this run.
  --no-open             Print the authorize URL without opening a browser.
  --from-cache          Analyze the last cached response without OAuth/API calls.
  --cache-file <path>   Override cache file path.
  --no-cache            Do not write the successful API response cache.

Known stream IDs:
  ${Object.keys(STREAMS).join(", ")}
`);
}

function parseArgs(argv) {
  const args = [...argv];
  const command = args.shift() ?? "battery";
  const options = {
    latest: false,
    days: undefined,
    start: undefined,
    end: undefined,
    nextToken: undefined,
    fields: undefined,
    limit: 5,
    low: 20,
    charged: 95,
    redirectUri: process.env.OURA_REDIRECT_URI ?? DEFAULT_REDIRECT_URI,
    scope: process.env.OURA_SCOPE ?? DEFAULT_SCOPE,
    openBrowser: true,
    fromCache: false,
    cacheFile: undefined,
    writeCache: true,
  };

  let streamId = command === "battery" ? "ring_battery_level" : undefined;
  if (command === "stream") {
    streamId = args.shift();
  }

  while (args.length > 0) {
    const arg = args.shift();
    switch (arg) {
      case "--latest":
        options.latest = true;
        break;
      case "--days":
        options.days = parsePositiveNumber(args.shift(), "--days");
        break;
      case "--start":
        options.start = requireValue(args.shift(), "--start");
        break;
      case "--end":
        options.end = requireValue(args.shift(), "--end");
        break;
      case "--next-token":
        options.nextToken = requireValue(args.shift(), "--next-token");
        break;
      case "--fields":
        options.fields = requireValue(args.shift(), "--fields");
        break;
      case "--limit":
        options.limit = parseNonNegativeInteger(args.shift(), "--limit");
        break;
      case "--low":
        options.low = parseNonNegativeInteger(args.shift(), "--low");
        break;
      case "--charged":
        options.charged = parseNonNegativeInteger(args.shift(), "--charged");
        break;
      case "--redirect-uri":
        options.redirectUri = requireValue(args.shift(), "--redirect-uri");
        break;
      case "--scope":
        options.scope = requireValue(args.shift(), "--scope");
        break;
      case "--no-open":
        options.openBrowser = false;
        break;
      case "--from-cache":
        options.fromCache = true;
        break;
      case "--cache-file":
        options.cacheFile = requireValue(args.shift(), "--cache-file");
        break;
      case "--no-cache":
        options.writeCache = false;
        break;
      case "--help":
      case "-h":
        usage();
        process.exit(0);
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (!streamId || !STREAMS[streamId]) {
    throw new Error(`Unknown streamId: ${streamId ?? "(missing)"}`);
  }

  return { command, streamId, options };
}

function requireValue(value, name) {
  if (!value || value.startsWith("--")) {
    throw new Error(`${name} requires a value`);
  }
  return value;
}

function parsePositiveNumber(value, name) {
  const parsed = Number(requireValue(value, name));
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive number`);
  }
  return parsed;
}

function parseNonNegativeInteger(value, name) {
  const parsed = Number(requireValue(value, name));
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`${name} must be a non-negative integer`);
  }
  return parsed;
}

function buildUrl(streamId, options) {
  const stream = STREAMS[streamId];
  const url = new URL(stream.path, OURA_API_BASE_URL);

  if (options.latest) {
    url.searchParams.set("latest", "true");
  }

  if (options.nextToken) {
    url.searchParams.set("next_token", options.nextToken);
  }

  if (options.fields) {
    url.searchParams.set("fields", options.fields);
  }

  const end = options.end ?? defaultEnd(stream.timeParams);
  const start = options.start ?? defaultStart(stream.timeParams, options.days ?? 1);

  if (!options.latest || options.start || options.end || options.days) {
    if (stream.timeParams === "date") {
      url.searchParams.set("start_date", asDate(start));
      url.searchParams.set("end_date", asDate(end));
    } else {
      url.searchParams.set("start_datetime", asDateTime(start));
      url.searchParams.set("end_datetime", asDateTime(end));
    }
  }

  return url;
}

function defaultEnd(timeParams) {
  const now = new Date();
  return timeParams === "date" ? asDate(now) : now.toISOString();
}

function defaultStart(timeParams, days) {
  const start = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  return timeParams === "date" ? asDate(start) : start.toISOString();
}

function asDate(value) {
  if (value instanceof Date) {
    return value.toISOString().slice(0, 10);
  }
  return String(value).slice(0, 10);
}

function asDateTime(value) {
  if (value instanceof Date) {
    return value.toISOString();
  }
  const text = String(value);
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) {
    return `${text}T00:00:00Z`;
  }
  return text;
}

function getRateLimitHeaders(headers) {
  const found = {};
  for (const header of RATE_LIMIT_HEADERS) {
    const value = headers.get(header);
    if (value !== null) {
      found[header] = value;
    }
  }
  return found;
}

async function resolveAccessToken(options) {
  if (process.env.OURA_ACCESS_TOKEN) {
    return process.env.OURA_ACCESS_TOKEN;
  }

  const clientId = process.env.OURA_CLIENT_ID;
  const clientSecret = process.env.OURA_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new Error("Missing OURA_CLIENT_ID or OURA_CLIENT_SECRET. Run through doppler or set env vars.");
  }

  const code = await runLocalOAuth({
    clientId,
    redirectUri: options.redirectUri,
    scope: options.scope,
    openBrowser: options.openBrowser,
  });
  const token = await exchangeCode({
    code,
    clientId,
    clientSecret,
    redirectUri: options.redirectUri,
  });

  console.log(
    JSON.stringify(
      {
        oauth: {
          tokenType: token.token_type ?? "Bearer",
          expiresIn: token.expires_in ?? null,
          scope: token.scope ?? null,
          refreshTokenReceived: Boolean(token.refresh_token),
        },
      },
      null,
      2,
    ),
  );

  return token.access_token;
}

async function runLocalOAuth(input) {
  const redirect = new URL(input.redirectUri);
  if (redirect.protocol !== "http:" || !["localhost", "127.0.0.1"].includes(redirect.hostname)) {
    throw new Error("Oura test OAuth redirect URI must be http://localhost or http://127.0.0.1.");
  }
  if (!redirect.port) {
    throw new Error("Oura test OAuth redirect URI must include an explicit local port.");
  }

  const state = crypto.randomBytes(24).toString("base64url");
  const authorizeUrl = new URL(OURA_AUTHORIZATION_ENDPOINT);
  authorizeUrl.searchParams.set("response_type", "code");
  authorizeUrl.searchParams.set("client_id", input.clientId);
  authorizeUrl.searchParams.set("redirect_uri", input.redirectUri);
  authorizeUrl.searchParams.set("scope", input.scope);
  authorizeUrl.searchParams.set("state", state);

  const callback = startOAuthCallbackServer({
    redirect,
    state,
  });
  await callback.ready;

  console.log(`Open Oura OAuth URL:\n${authorizeUrl.toString()}`);
  if (input.openBrowser) {
    openBrowser(authorizeUrl.toString());
  }

  return callback.code;
}

function startOAuthCallbackServer({ redirect, state }) {
  let settled = false;
  let listening = false;
  let resolveReady;
  let rejectReady;
  let resolveCode;
  let rejectCode;
  const ready = new Promise((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  const code = new Promise((resolve, reject) => {
    resolveCode = resolve;
    rejectCode = reject;
  });

  const server = http.createServer((request, response) => {
    try {
      const requestUrl = new URL(request.url ?? "/", redirect);
      if (requestUrl.pathname !== redirect.pathname) {
        response.writeHead(404, { "Content-Type": "text/plain" });
        response.end("Not found");
        return;
      }

      const error = requestUrl.searchParams.get("error");
      if (error) {
        throw new Error(
          `Oura OAuth failed: ${error} ${requestUrl.searchParams.get("error_description") ?? ""}`.trim(),
        );
      }

      const returnedState = requestUrl.searchParams.get("state");
      if (returnedState !== state) {
        throw new Error("Oura OAuth callback state mismatch.");
      }

      const oauthCode = requestUrl.searchParams.get("code");
      if (!oauthCode) {
        throw new Error("Oura OAuth callback did not include a code.");
      }

      response.writeHead(200, { "Content-Type": "text/html" });
      response.end("<!doctype html><title>Oura connected</title><p>Oura connected. You can close this tab.</p>");
      cleanup();
      resolveCode(oauthCode);
    } catch (error) {
      response.writeHead(400, { "Content-Type": "text/plain" });
      response.end(error instanceof Error ? error.message : String(error));
      cleanup();
      rejectCode(error);
    }
  });

  const timeout = setTimeout(() => {
    cleanup();
    rejectCode(new Error("Timed out waiting for Oura OAuth callback."));
  }, OAUTH_WAIT_MS);

  function cleanup() {
    if (settled) return;
    settled = true;
    clearTimeout(timeout);
    if (listening) {
      server.close();
    }
  }

  server.on("error", (error) => {
    cleanup();
    rejectReady(error);
    rejectCode(error);
  });
  server.listen(Number(redirect.port), redirect.hostname, () => {
    listening = true;
    console.log(`Waiting for Oura OAuth callback on ${redirect.toString()}`);
    resolveReady();
  });

  return { ready, code };
}

function openBrowser(url) {
  const command = process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  const child = spawn(command, args, {
    detached: true,
    stdio: "ignore",
  });
  child.unref();
}

async function exchangeCode(input) {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code: input.code,
    redirect_uri: input.redirectUri,
    client_id: input.clientId,
    client_secret: input.clientSecret,
  });
  const response = await fetch(OURA_TOKEN_ENDPOINT, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body,
  });
  const token = await parseJsonResponse(response);
  if (!response.ok) {
    throw new Error(
      `Oura token exchange failed (${response.status}): ${token.error ?? "unknown_error"} ${
        token.error_description ?? ""
      }`.trim(),
    );
  }
  if (!token.access_token) {
    throw new Error("Oura token exchange returned no access_token.");
  }
  return token;
}

async function parseJsonResponse(response) {
  const text = await response.text();
  return text ? JSON.parse(text) : {};
}

function cacheFileFor(streamId, options) {
  return options.cacheFile ?? join(DEFAULT_CACHE_DIR, `${streamId}-last.json`);
}

async function writeCacheFile(streamId, options, payload) {
  if (!options.writeCache) {
    return;
  }
  const cacheFile = cacheFileFor(streamId, options);
  await mkdir(dirname(cacheFile), { recursive: true });
  await writeFile(cacheFile, JSON.stringify(payload, null, 2) + "\n", "utf8");
  console.log(`Wrote cache ${cacheFile}`);
}

async function readCacheFile(streamId, options) {
  const cacheFile = cacheFileFor(streamId, options);
  const payload = JSON.parse(await readFile(cacheFile, "utf8"));
  console.log(`Read cache ${cacheFile}`);
  return payload;
}

function summarizeBattery(samples, options) {
  const sorted = [...samples].sort((a, b) => {
    const aTime = Date.parse(a.timestamp ?? "");
    const bTime = Date.parse(b.timestamp ?? "");
    return aTime - bTime;
  });
  const intervalsMinutes = [];
  for (let index = 1; index < sorted.length; index++) {
    const previous = Date.parse(sorted[index - 1].timestamp ?? "");
    const current = Date.parse(sorted[index].timestamp ?? "");
    if (Number.isFinite(previous) && Number.isFinite(current) && current >= previous) {
      intervalsMinutes.push((current - previous) / 60_000);
    }
  }
  const levels = samples
    .map((sample) => sample.level)
    .filter((level) => typeof level === "number");
  const lowSamples = samples.filter(
    (sample) => typeof sample.level === "number" && sample.level <= options.low,
  );
  const chargedSamples = samples.filter(
    (sample) => typeof sample.level === "number" && sample.level >= options.charged,
  );
  const lowRuns = summarizeThresholdRuns(
    sorted,
    (sample) => typeof sample.level === "number" && sample.level <= options.low,
  );
  const chargedRuns = summarizeThresholdRuns(
    sorted,
    (sample) => typeof sample.level === "number" && sample.level >= options.charged,
  );

  return {
    earliest: sorted[0] ?? null,
    latest: sorted.at(-1) ?? null,
    intervalMinutes: summarizeIntervals(intervalsMinutes),
    minLevel: levels.length > 0 ? Math.min(...levels) : null,
    maxLevel: levels.length > 0 ? Math.max(...levels) : null,
    lowThreshold: options.low,
    lowSamples: lowSamples.length,
    lowRuns,
    chargedThreshold: options.charged,
    chargedSamples: chargedSamples.length,
    chargedRuns,
  };
}

function summarizeThresholdRuns(samples, matches) {
  const runs = [];
  let current = null;
  for (const sample of samples) {
    if (matches(sample)) {
      if (!current) {
        current = {
          start: sample.timestamp ?? null,
          end: sample.timestamp ?? null,
          samples: 0,
          minLevel: typeof sample.level === "number" ? sample.level : null,
          maxLevel: typeof sample.level === "number" ? sample.level : null,
        };
        runs.push(current);
      }
      current.end = sample.timestamp ?? current.end;
      current.samples += 1;
      if (typeof sample.level === "number") {
        current.minLevel = current.minLevel === null ? sample.level : Math.min(current.minLevel, sample.level);
        current.maxLevel = current.maxLevel === null ? sample.level : Math.max(current.maxLevel, sample.level);
      }
    } else {
      current = null;
    }
  }
  return {
    count: runs.length,
    runs: runs.slice(0, 10),
  };
}

function summarizeIntervals(minutes) {
  if (minutes.length === 0) {
    return null;
  }
  const sorted = [...minutes].sort((a, b) => a - b);
  const sum = sorted.reduce((total, value) => total + value, 0);
  return {
    count: sorted.length,
    average: round(sum / sorted.length),
    min: round(sorted[0]),
    p50: round(percentile(sorted, 0.5)),
    p90: round(percentile(sorted, 0.9)),
    max: round(sorted.at(-1)),
  };
}

function percentile(sorted, ratio) {
  if (sorted.length === 0) {
    return 0;
  }
  const index = Math.min(sorted.length - 1, Math.max(0, Math.floor((sorted.length - 1) * ratio)));
  return sorted[index];
}

function round(value) {
  return Math.round(value * 10) / 10;
}

async function main() {
  if (process.argv.slice(2).some((arg) => arg === "--help" || arg === "-h")) {
    usage();
    process.exit(0);
  }

  const { command, streamId, options } = parseArgs(process.argv.slice(2));
  if (command !== "battery" && command !== "stream") {
    throw new Error(`Unknown command: ${command}`);
  }

  let body;
  let result;
  if (options.fromCache) {
    const cache = await readCacheFile(streamId, options);
    body = cache.body ?? {};
    result = {
      status: cache.status ?? null,
      ok: true,
      rateLimit: cache.rateLimit ?? {},
      count: Array.isArray(body.data) ? body.data.length : 0,
      nextToken: body.next_token ?? null,
      cachedAt: cache.fetchedAt ?? null,
      cachedUrl: cache.url ?? null,
    };
  } else {
    const accessToken = await resolveAccessToken(options);
    const url = buildUrl(streamId, options);
    console.log(`GET ${url.toString()}`);

    const response = await fetch(url, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: "application/json",
      },
    });
    body = await parseJsonResponse(response);
    result = {
      status: response.status,
      ok: response.ok,
      rateLimit: getRateLimitHeaders(response.headers),
      count: Array.isArray(body.data) ? body.data.length : 0,
      nextToken: body.next_token ?? null,
    };
    if (!response.ok) {
      console.log(JSON.stringify(result, null, 2));
      console.error(JSON.stringify(body, null, 2));
      process.exit(1);
    }
    await writeCacheFile(streamId, options, {
      fetchedAt: new Date().toISOString(),
      url: url.toString(),
      status: response.status,
      rateLimit: result.rateLimit,
      body,
    });
  }
  const data = Array.isArray(body.data) ? body.data : [];

  console.log(JSON.stringify(result, null, 2));

  if (streamId === "ring_battery_level") {
    console.log(JSON.stringify({ battery: summarizeBattery(data, options) }, null, 2));
  }

  console.log(
    JSON.stringify(
      {
        samples: data.slice(0, options.limit),
      },
      null,
      2,
    ),
  );
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  usage();
  process.exit(1);
});
