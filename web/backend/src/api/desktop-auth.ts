import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DeleteCommand,
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import type { APIGatewayProxyEventV2 } from "aws-lambda";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

import { getConfig } from "./config";
import { getLamarckUserById, requireLamarckUser, type LamarckUser } from "./identity";
import { bearerToken, HttpError } from "./http";

const DESKTOP_CODE_TTL_SECONDS = 5 * 60;
const ACCESS_TOKEN_TTL_MS = 60 * 60 * 1000;
const REFRESH_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const DESKTOP_REDIRECT_PORTS = new Set(["32100", "32101", "32102"]);

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
  marshallOptions: {
    removeUndefinedValues: true,
  },
});

interface DesktopAuthorizeRequest {
  redirectUri?: string;
  state?: string;
  codeChallenge?: string;
  codeChallengeMethod?: string;
  deviceName?: string;
}

interface DesktopTokenRequest {
  grantType?: string;
  code?: string;
  redirectUri?: string;
  codeVerifier?: string;
  refreshToken?: string;
}

interface DesktopCodeItem {
  state: string;
  kind: "desktopAuthCode";
  userId: string;
  csrfState: string;
  redirectUri: string;
  codeChallenge: string;
  codeChallengeMethod: "S256";
  deviceName?: string;
  createdAt: string;
  expiresAt: number;
}

interface DesktopSessionItem {
  sessionId: string;
  userId: string;
  status: "active" | "revoked";
  accessTokenHash: string;
  refreshTokenHash: string;
  accessTokenExpiresAt: number;
  refreshTokenExpiresAt: number;
  deviceName?: string;
  createdAt: string;
  updatedAt: string;
  lastSeenAt: string;
  expiresAt: number;
}

export async function authorizeDesktop(
  event: APIGatewayProxyEventV2,
): Promise<{ redirectUrl: string; codeExpiresAt: string }> {
  const user = await requireLamarckUser(event);
  const body = readJsonBody<DesktopAuthorizeRequest>(event);
  const redirectUri = requireDesktopRedirectUri(body.redirectUri);
  const csrfState = requireNonEmpty(body.state, "state");
  const codeChallenge = requirePkceChallenge(body.codeChallenge);
  if (body.codeChallengeMethod !== "S256") {
    throw new HttpError(400, "invalid_pkce", "Desktop auth requires PKCE S256.");
  }

  const now = new Date();
  const expiresAt = Math.floor(now.getTime() / 1000) + DESKTOP_CODE_TTL_SECONDS;
  const code = randomToken(32);
  const item: DesktopCodeItem = {
    state: desktopCodeKey(code),
    kind: "desktopAuthCode",
    userId: user.userId,
    csrfState,
    redirectUri,
    codeChallenge,
    codeChallengeMethod: "S256",
    deviceName: normalizeOptionalString(body.deviceName),
    createdAt: now.toISOString(),
    expiresAt,
  };

  await ddb.send(
    new PutCommand({
      TableName: getConfig().oauthStateTable,
      Item: item,
      ConditionExpression: "attribute_not_exists(#state)",
      ExpressionAttributeNames: {
        "#state": "state",
      },
    }),
  );

  const callback = new URL(redirectUri);
  callback.searchParams.set("code", code);
  callback.searchParams.set("state", csrfState);

  return {
    redirectUrl: callback.toString(),
    codeExpiresAt: new Date(expiresAt * 1000).toISOString(),
  };
}

export async function exchangeDesktopToken(
  event: APIGatewayProxyEventV2,
): Promise<DesktopTokenResponse> {
  const body = readJsonBody<DesktopTokenRequest>(event);
  if (body.grantType === "authorization_code") {
    return exchangeAuthorizationCode(body);
  }
  if (body.grantType === "refresh_token") {
    return refreshDesktopToken(body);
  }
  throw new HttpError(400, "unsupported_grant_type", "Unsupported desktop auth grant type.");
}

export async function requireDesktopUser(event: APIGatewayProxyEventV2): Promise<LamarckUser> {
  const token = bearerToken(event);
  if (!token) {
    throw new HttpError(401, "missing_session", "Missing Lamarck desktop bearer token.");
  }
  const session = await verifyDesktopAccessToken(token);
  return getLamarckUserById(session.userId);
}

export async function revokeDesktopSession(
  event: APIGatewayProxyEventV2,
): Promise<{ ok: true }> {
  const token = bearerToken(event);
  if (!token) {
    throw new HttpError(401, "missing_session", "Missing Lamarck desktop bearer token.");
  }
  const parsed = parseSessionToken(token, "access");
  const now = new Date().toISOString();
  await ddb.send(
    new UpdateCommand({
      TableName: getConfig().desktopSessionsTable,
      Key: { sessionId: parsed.sessionId },
      UpdateExpression: "SET #status = :revoked, updatedAt = :now",
      ConditionExpression: "attribute_exists(sessionId)",
      ExpressionAttributeNames: {
        "#status": "status",
      },
      ExpressionAttributeValues: {
        ":revoked": "revoked",
        ":now": now,
      },
    }),
  );
  return { ok: true };
}

export function isDesktopAccessToken(token: string | null): boolean {
  return Boolean(token?.startsWith("lma_at."));
}

async function exchangeAuthorizationCode(body: DesktopTokenRequest): Promise<DesktopTokenResponse> {
  const code = requireNonEmpty(body.code, "code");
  const redirectUri = requireDesktopRedirectUri(body.redirectUri);
  const codeVerifier = requireNonEmpty(body.codeVerifier, "codeVerifier");
  const key = desktopCodeKey(code);

  const result = await ddb.send(
    new GetCommand({
      TableName: getConfig().oauthStateTable,
      Key: { state: key },
      ConsistentRead: true,
    }),
  );
  const item = result.Item as DesktopCodeItem | undefined;
  if (!item || item.kind !== "desktopAuthCode") {
    throw new HttpError(400, "invalid_code", "Desktop auth code is invalid or expired.");
  }
  if (item.expiresAt <= Math.floor(Date.now() / 1000)) {
    await deleteDesktopCode(key);
    throw new HttpError(400, "expired_code", "Desktop auth code expired.");
  }
  if (item.redirectUri !== redirectUri) {
    throw new HttpError(400, "invalid_redirect_uri", "Desktop redirect URI does not match the auth code.");
  }
  if (pkceChallenge(codeVerifier) !== item.codeChallenge) {
    throw new HttpError(400, "invalid_pkce", "Desktop PKCE verifier does not match the auth code.");
  }

  await deleteDesktopCode(key);
  return createDesktopSession({
    userId: item.userId,
    deviceName: item.deviceName,
  });
}

async function refreshDesktopToken(body: DesktopTokenRequest): Promise<DesktopTokenResponse> {
  const refreshToken = requireNonEmpty(body.refreshToken, "refreshToken");
  const parsed = parseSessionToken(refreshToken, "refresh");
  const session = await getSession(parsed.sessionId);
  if (session.status !== "active") {
    throw new HttpError(401, "session_revoked", "Desktop session has been revoked.");
  }
  if (!constantTimeEqual(session.refreshTokenHash, tokenHash(refreshToken))) {
    throw new HttpError(401, "invalid_session", "Desktop refresh token is invalid.");
  }
  if (session.refreshTokenExpiresAt <= Date.now()) {
    throw new HttpError(401, "session_expired", "Desktop session expired.");
  }

  return rotateDesktopSession(session);
}

async function verifyDesktopAccessToken(token: string): Promise<DesktopSessionItem> {
  const parsed = parseSessionToken(token, "access");
  const session = await getSession(parsed.sessionId);
  if (session.status !== "active") {
    throw new HttpError(401, "session_revoked", "Desktop session has been revoked.");
  }
  if (!constantTimeEqual(session.accessTokenHash, tokenHash(token))) {
    throw new HttpError(401, "invalid_session", "Desktop access token is invalid.");
  }
  if (session.accessTokenExpiresAt <= Date.now()) {
    throw new HttpError(401, "session_expired", "Desktop access token expired.");
  }

  await ddb.send(
    new UpdateCommand({
      TableName: getConfig().desktopSessionsTable,
      Key: { sessionId: session.sessionId },
      UpdateExpression: "SET lastSeenAt = :now",
      ExpressionAttributeValues: {
        ":now": new Date().toISOString(),
      },
    }),
  );

  return session;
}

async function createDesktopSession(input: {
  userId: string;
  deviceName?: string;
}): Promise<DesktopTokenResponse> {
  const sessionId = `dsk_${randomToken(16)}`;
  const issued = issueSessionTokens(sessionId);
  const now = new Date().toISOString();
  const item: DesktopSessionItem = {
    sessionId,
    userId: input.userId,
    status: "active",
    accessTokenHash: tokenHash(issued.accessToken),
    refreshTokenHash: tokenHash(issued.refreshToken),
    accessTokenExpiresAt: issued.accessTokenExpiresAt,
    refreshTokenExpiresAt: issued.refreshTokenExpiresAt,
    deviceName: input.deviceName,
    createdAt: now,
    updatedAt: now,
    lastSeenAt: now,
    expiresAt: Math.floor(issued.refreshTokenExpiresAt / 1000),
  };

  await ddb.send(
    new PutCommand({
      TableName: getConfig().desktopSessionsTable,
      Item: item,
      ConditionExpression: "attribute_not_exists(sessionId)",
    }),
  );

  return tokenResponse(item, issued);
}

async function rotateDesktopSession(session: DesktopSessionItem): Promise<DesktopTokenResponse> {
  const issued = issueSessionTokens(session.sessionId);
  const now = new Date().toISOString();
  await ddb.send(
    new UpdateCommand({
      TableName: getConfig().desktopSessionsTable,
      Key: { sessionId: session.sessionId },
      UpdateExpression: [
        "SET accessTokenHash = :accessTokenHash",
        "refreshTokenHash = :refreshTokenHash",
        "accessTokenExpiresAt = :accessTokenExpiresAt",
        "refreshTokenExpiresAt = :refreshTokenExpiresAt",
        "updatedAt = :now",
        "lastSeenAt = :now",
        "expiresAt = :expiresAt",
      ].join(", "),
      ConditionExpression: "refreshTokenHash = :oldRefreshTokenHash AND #status = :active",
      ExpressionAttributeNames: {
        "#status": "status",
      },
      ExpressionAttributeValues: {
        ":accessTokenHash": tokenHash(issued.accessToken),
        ":refreshTokenHash": tokenHash(issued.refreshToken),
        ":accessTokenExpiresAt": issued.accessTokenExpiresAt,
        ":refreshTokenExpiresAt": issued.refreshTokenExpiresAt,
        ":oldRefreshTokenHash": session.refreshTokenHash,
        ":active": "active",
        ":now": now,
        ":expiresAt": Math.floor(issued.refreshTokenExpiresAt / 1000),
      },
    }),
  );

  return tokenResponse(session, issued);
}

async function getSession(sessionId: string): Promise<DesktopSessionItem> {
  const result = await ddb.send(
    new GetCommand({
      TableName: getConfig().desktopSessionsTable,
      Key: { sessionId },
      ConsistentRead: true,
    }),
  );
  const item = result.Item as DesktopSessionItem | undefined;
  if (!item?.sessionId) {
    throw new HttpError(401, "invalid_session", "Desktop session was not found.");
  }
  return item;
}

async function deleteDesktopCode(key: string): Promise<void> {
  try {
    await ddb.send(
      new DeleteCommand({
        TableName: getConfig().oauthStateTable,
        Key: { state: key },
        ConditionExpression: "attribute_exists(#state)",
        ExpressionAttributeNames: {
          "#state": "state",
        },
      }),
    );
  } catch (error) {
    if (isConditionalCheckFailed(error)) {
      throw new HttpError(400, "invalid_code", "Desktop auth code is invalid or already used.");
    }
    throw error;
  }
}

interface IssuedSessionTokens {
  accessToken: string;
  refreshToken: string;
  accessTokenExpiresAt: number;
  refreshTokenExpiresAt: number;
}

interface DesktopTokenResponse {
  tokenType: "Bearer";
  accessToken: string;
  refreshToken: string;
  accessTokenExpiresAt: string;
  refreshTokenExpiresAt: string;
  userId: string;
  sessionId: string;
}

function issueSessionTokens(sessionId: string): IssuedSessionTokens {
  return {
    accessToken: `lma_at.${sessionId}.${randomToken(32)}`,
    refreshToken: `lma_rt.${sessionId}.${randomToken(32)}`,
    accessTokenExpiresAt: Date.now() + ACCESS_TOKEN_TTL_MS,
    refreshTokenExpiresAt: Date.now() + REFRESH_TOKEN_TTL_MS,
  };
}

function tokenResponse(
  session: Pick<DesktopSessionItem, "sessionId" | "userId">,
  issued: IssuedSessionTokens,
): DesktopTokenResponse {
  return {
    tokenType: "Bearer",
    accessToken: issued.accessToken,
    refreshToken: issued.refreshToken,
    accessTokenExpiresAt: new Date(issued.accessTokenExpiresAt).toISOString(),
    refreshTokenExpiresAt: new Date(issued.refreshTokenExpiresAt).toISOString(),
    userId: session.userId,
    sessionId: session.sessionId,
  };
}

function parseSessionToken(
  token: string,
  expectedKind: "access" | "refresh",
): { sessionId: string } {
  const expectedPrefix = expectedKind === "access" ? "lma_at" : "lma_rt";
  const parts = token.split(".");
  if (parts.length !== 3 || parts[0] !== expectedPrefix || !parts[1] || !parts[2]) {
    throw new HttpError(401, "invalid_session", `Invalid Lamarck ${expectedKind} token.`);
  }
  return { sessionId: parts[1] };
}

function requireDesktopRedirectUri(value: unknown): string {
  const redirectUri = requireNonEmpty(value, "redirectUri");
  let url: URL;
  try {
    url = new URL(redirectUri);
  } catch {
    throw new HttpError(400, "invalid_redirect_uri", "Desktop redirect URI is invalid.");
  }
  if (
    url.protocol !== "http:" ||
    url.hostname !== "localhost" ||
    url.pathname !== "/auth/callback" ||
    !DESKTOP_REDIRECT_PORTS.has(url.port) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new HttpError(
      400,
      "invalid_redirect_uri",
      "Desktop redirect URI must be http://localhost:32100/auth/callback, :32101, or :32102.",
    );
  }
  return url.toString();
}

function requirePkceChallenge(value: unknown): string {
  const challenge = requireNonEmpty(value, "codeChallenge");
  if (!/^[A-Za-z0-9_-]{43,128}$/.test(challenge)) {
    throw new HttpError(400, "invalid_pkce", "Desktop PKCE code challenge is invalid.");
  }
  return challenge;
}

function requireNonEmpty(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new HttpError(400, "invalid_request", `Missing ${field}.`);
  }
  return value.trim();
}

function normalizeOptionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim().slice(0, 120) : undefined;
}

function readJsonBody<T>(event: APIGatewayProxyEventV2): T {
  if (!event.body) return {} as T;
  const text = event.isBase64Encoded
    ? Buffer.from(event.body, "base64").toString("utf8")
    : event.body;
  return JSON.parse(text) as T;
}

function desktopCodeKey(code: string): string {
  return `desktop-auth-code:${tokenHash(code)}`;
}

function tokenHash(token: string): string {
  return createHash("sha256").update(token).digest("base64url");
}

function pkceChallenge(verifier: string): string {
  return tokenHash(verifier);
}

function randomToken(bytes: number): string {
  return randomBytes(bytes).toString("base64url");
}

function constantTimeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

function isConditionalCheckFailed(error: unknown): boolean {
  return typeof error === "object" &&
    error !== null &&
    "name" in error &&
    error.name === "ConditionalCheckFailedException";
}
