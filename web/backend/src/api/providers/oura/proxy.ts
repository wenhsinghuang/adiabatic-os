import { HttpError } from "../../http";
import { logInfo, logWarn } from "../../log";
import type { ManagedProviderProxyContext } from "../types";
import {
  getFreshOuraAccessToken,
  refreshOuraAfterUnauthorized,
} from "./tokens";

const OURA_API_ORIGIN = "https://api.ouraring.com";

const DATE_PARAMS = new Set(["start_date", "end_date", "next_token", "fields"]);
const DATETIME_PARAMS = new Set(["start_datetime", "end_datetime", "next_token", "latest", "fields"]);
const PAGE_PARAMS = new Set(["next_token", "fields"]);

const STREAMS: Record<string, { path: string; params: Set<string> }> = {
  daily_activity: { path: "/v2/usercollection/daily_activity", params: DATE_PARAMS },
  daily_sleep: { path: "/v2/usercollection/daily_sleep", params: DATE_PARAMS },
  daily_readiness: { path: "/v2/usercollection/daily_readiness", params: DATE_PARAMS },
  sleep: { path: "/v2/usercollection/sleep", params: DATE_PARAMS },
  sleep_time: { path: "/v2/usercollection/sleep_time", params: DATE_PARAMS },
  daily_spo2: { path: "/v2/usercollection/daily_spo2", params: DATE_PARAMS },
  daily_stress: { path: "/v2/usercollection/daily_stress", params: DATE_PARAMS },
  workout: { path: "/v2/usercollection/workout", params: DATE_PARAMS },
  session: { path: "/v2/usercollection/session", params: DATE_PARAMS },
  tag: { path: "/v2/usercollection/tag", params: DATE_PARAMS },
  enhanced_tag: { path: "/v2/usercollection/enhanced_tag", params: DATE_PARAMS },
  rest_mode_period: { path: "/v2/usercollection/rest_mode_period", params: DATE_PARAMS },
  daily_resilience: { path: "/v2/usercollection/daily_resilience", params: DATE_PARAMS },
  daily_cardiovascular_age: { path: "/v2/usercollection/daily_cardiovascular_age", params: DATE_PARAMS },
  vo2_max: { path: "/v2/usercollection/vO2_max", params: DATE_PARAMS },
  ring_configuration: { path: "/v2/usercollection/ring_configuration", params: PAGE_PARAMS },
  heartrate: { path: "/v2/usercollection/heartrate", params: DATETIME_PARAMS },
  ring_battery_level: { path: "/v2/usercollection/ring_battery_level", params: DATETIME_PARAMS },
};

export async function handleProxy(ctx: ManagedProviderProxyContext) {
  const startedAt = Date.now();
  if (ctx.event.requestContext.http.method !== "GET") {
    throw new HttpError(405, "method_not_allowed", "Oura provider proxy currently supports GET only.");
  }
  const match = (ctx.event.pathParameters?.proxy ?? "").match(/^v1\/streams\/([^/]+)$/);
  if (!match) {
    throw new HttpError(404, "provider_endpoint_not_found", "Oura provider endpoint not found.", {
      path: ctx.event.pathParameters?.proxy ?? null,
    });
  }

  const streamId = decodeURIComponent(match[1]);
  const stream = STREAMS[streamId];
  if (!stream) {
    throw new HttpError(404, "oura_stream_not_found", "Oura stream is not exposed by this provider API.", {
      streamId,
    });
  }

  const query = allowedQuery(ctx.event.queryStringParameters ?? {}, stream.params);
  const baseLog = {
    providerId: ctx.capability.providerId,
    userId: ctx.capability.userId,
    integrationId: ctx.capability.integrationId,
    streamId,
    ...queryLogFields(query),
  };

  try {
    const firstToken = await getFreshOuraAccessToken(ctx.capability);
    const first = await fetchOuraPage(stream.path, query, firstToken);
    if (first.status !== 401) {
      const response = pageResponse(first);
      logOuraProxy("oura.proxy.request", baseLog, first, response, startedAt, false);
      return response;
    }

    logWarn("oura.proxy.refresh_after_unauthorized", {
      ...baseLog,
      providerStatus: first.status,
      durationMs: Date.now() - startedAt,
    });
    const refreshedToken = await refreshOuraAfterUnauthorized(ctx.capability);
    const second = await fetchOuraPage(stream.path, query, refreshedToken);
    const response = pageResponse(second);
    logOuraProxy("oura.proxy.request", baseLog, second, response, startedAt, true);
    return response;
  } catch (error) {
    if (error instanceof HttpError) {
      logWarn("oura.proxy.failed", {
        ...baseLog,
        statusCode: error.statusCode,
        error: error.code,
        durationMs: Date.now() - startedAt,
        ...httpErrorDetails(error.details),
      });
    } else {
      logWarn("oura.proxy.failed", {
        ...baseLog,
        error: error instanceof Error ? error.message : String(error),
        durationMs: Date.now() - startedAt,
      });
    }
    throw error;
  }
}

function allowedQuery(input: Record<string, string | undefined>, allowed: Set<string>): URLSearchParams {
  const output = new URLSearchParams();
  for (const [key, value] of Object.entries(input)) {
    if (!allowed.has(key)) {
      throw new HttpError(400, "invalid_query_parameter", "Query parameter is not allowed for this Oura stream.", {
        parameter: key,
      });
    }
    if (value !== undefined && value !== "") output.set(key, value);
  }
  return output;
}

async function fetchOuraPage(
  path: string,
  query: URLSearchParams,
  accessToken: string,
): Promise<{ status: number; headers: Headers; body: unknown }> {
  const url = new URL(path, OURA_API_ORIGIN);
  for (const [key, value] of query.entries()) {
    url.searchParams.set(key, value);
  }
  const response = await fetch(url.toString(), {
    method: "GET",
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${accessToken}`,
    },
  });
  const text = await response.text();
  return {
    status: response.status,
    headers: response.headers,
    body: text ? JSON.parse(text) : {},
  };
}

function pageResponse(result: { status: number; headers: Headers; body: unknown }) {
  if (result.status < 200 || result.status >= 300) {
    const body = isObject(result.body) ? result.body : {};
    const retryAfter = result.headers.get("retry-after");
    throw new HttpError(
      result.status === 429 ? 429 : 502,
      result.status === 429 ? "oura_rate_limited" : "oura_api_error",
      messageFromOuraBody(body, result.status),
      {
        providerStatus: result.status,
        retryAfter,
        rateLimitTier: result.headers.get("x-ratelimit-tier"),
      },
    );
  }
  const body = isObject(result.body) ? result.body : {};
  return {
    data: Array.isArray(body.data) ? body.data : [],
    nextToken: typeof body.next_token === "string" && body.next_token ? body.next_token : undefined,
  };
}

function logOuraProxy(
  event: string,
  baseLog: Record<string, unknown>,
  result: { status: number; headers: Headers },
  response: { data: unknown[]; nextToken?: string },
  startedAt: number,
  refreshed: boolean,
): void {
  const fields = {
    ...baseLog,
    providerStatus: result.status,
    durationMs: Date.now() - startedAt,
    refreshed,
    itemCount: response.data.length,
    hasNextToken: Boolean(response.nextToken),
    retryAfter: result.headers.get("retry-after"),
    rateLimitTier: result.headers.get("x-ratelimit-tier"),
    rateLimitLimit: result.headers.get("x-ratelimit-limit"),
    rateLimitWindow: result.headers.get("x-ratelimit-window"),
    rateLimitReset: result.headers.get("x-ratelimit-reset"),
  };
  if (result.status === 429 || result.headers.get("x-ratelimit-tier")) {
    logWarn(event, fields);
  } else {
    logInfo(event, fields);
  }
}

function queryLogFields(query: URLSearchParams): Record<string, unknown> {
  return {
    startDate: query.get("start_date") ?? undefined,
    endDate: query.get("end_date") ?? undefined,
    startDatetime: query.get("start_datetime") ?? undefined,
    endDatetime: query.get("end_datetime") ?? undefined,
    hasCursor: query.has("next_token"),
    latest: query.get("latest") ?? undefined,
    fields: query.get("fields") ?? undefined,
  };
}

function httpErrorDetails(details: unknown): Record<string, unknown> {
  if (!isObject(details)) return {};
  return {
    providerStatus: details.providerStatus,
    retryAfter: details.retryAfter,
    rateLimitTier: details.rateLimitTier,
  };
}

function messageFromOuraBody(body: Record<string, unknown>, status: number): string {
  return typeof body.detail === "string"
    ? body.detail
    : typeof body.message === "string"
      ? body.message
      : `Oura API returned ${status}`;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
