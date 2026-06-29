import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  GetCommand,
  PutCommand,
  UpdateCommand,
  DynamoDBDocumentClient,
} from "@aws-sdk/lib-dynamodb";
import type { APIGatewayProxyEventV2 } from "aws-lambda";
import { createHash, randomBytes } from "node:crypto";

import { getConfig } from "./config";
import { requireDesktopUser } from "./desktop-auth";
import { bearerToken, HttpError } from "./http";
import { logInfo } from "./log";
import type { ManagedProviderMetadata } from "./providers/types";

const CAPABILITY_TOKEN_TTL_MS = 24 * 60 * 60 * 1000;
const INTEGRATION_ID_PATTERN = /^[A-Za-z0-9_-]{6,128}$/;

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
  marshallOptions: {
    removeUndefinedValues: true,
  },
});

export type ManagedProviderConnectionStatus = "connected" | "needs_reconnect" | "revoked";

export interface ManagedProviderConnectionItem {
  userId: string;
  integrationId: string;
  providerId: string;
  status: ManagedProviderConnectionStatus;
  providerSubject?: string;
  providerEmail?: string;
  grantedScopes?: string[];
  encryptedTokenEnvelope?: string;
  lastRefreshAt?: string;
  lastError?: string;
  createdAt: string;
  updatedAt: string;
}

interface ManagedProviderCapabilityTokenItem {
  tokenHash: string;
  userId: string;
  integrationId: string;
  providerId: string;
  allowedPrefix: string;
  createdAt: string;
  expiresAt: number;
  revokedAt?: string;
  lastSeenAt?: string;
}

export interface ManagedProviderCapability {
  userId: string;
  integrationId: string;
  providerId: string;
  allowedPrefix: string;
}

interface CapabilityTokenRequest {
  integrationId?: string;
}

export interface ManagedProviderCapabilityTokenResponse {
  tokenType: "Bearer";
  accessToken: string;
  expiresAt: string;
  providerId: string;
  integrationId: string;
}

export interface ManagedProviderConnectionView {
  providerId: string;
  integrationId: string;
  status: "not_connected" | ManagedProviderConnectionStatus;
  providerSubject?: string;
  providerEmail?: string;
  grantedScopes?: string[];
  lastRefreshAt?: string;
  lastError?: string;
  createdAt?: string;
  updatedAt?: string;
}

export async function issueManagedProviderCapabilityToken(
  event: APIGatewayProxyEventV2,
  metadata: ManagedProviderMetadata,
): Promise<ManagedProviderCapabilityTokenResponse> {
  const user = await requireDesktopUser(event);
  const body = readJsonBody<CapabilityTokenRequest>(event);
  const integrationId = requireIntegrationId(body.integrationId);
  const connection = await getManagedProviderConnection(user.userId, integrationId);
  if (!connection || connection.providerId !== metadata.providerId) {
    throw new HttpError(409, "managed_provider_not_connected", "Managed provider is not connected for this integration.", {
      providerId: metadata.providerId,
      integrationId,
    });
  }
  if (connection.status !== "connected") {
    throw new HttpError(409, "managed_provider_not_connected", "Managed provider connection is not active.", {
      providerId: metadata.providerId,
      integrationId,
      status: connection.status,
    });
  }

  const accessToken = `lmp_cap.${randomToken(32)}`;
  const nowMs = Date.now();
  const expiresAtMs = nowMs + CAPABILITY_TOKEN_TTL_MS;
  const expiresAt = Math.floor(expiresAtMs / 1000);
  const item: ManagedProviderCapabilityTokenItem = {
    tokenHash: tokenHash(accessToken),
    userId: user.userId,
    integrationId,
    providerId: metadata.providerId,
    allowedPrefix: `${metadata.apiBasePath}/v1/`,
    createdAt: new Date(nowMs).toISOString(),
    expiresAt,
  };

  await ddb.send(
    new PutCommand({
      TableName: getConfig().managedProviderCapabilityTokensTable,
      Item: item,
      ConditionExpression: "attribute_not_exists(tokenHash)",
    }),
  );

  logInfo("managed_provider.capability.issued", {
    providerId: metadata.providerId,
    userId: user.userId,
    integrationId,
    allowedPrefix: item.allowedPrefix,
    expiresAt,
  });

  return {
    tokenType: "Bearer",
    accessToken,
    expiresAt: new Date(expiresAtMs).toISOString(),
    providerId: metadata.providerId,
    integrationId,
  };
}

export async function requireManagedProviderCapability(
  event: APIGatewayProxyEventV2,
  metadata: ManagedProviderMetadata,
): Promise<ManagedProviderCapability> {
  const token = bearerToken(event);
  if (!token) {
    throw new HttpError(401, "missing_capability", "Missing managed provider capability token.");
  }
  if (!token.startsWith("lmp_cap.")) {
    throw new HttpError(401, "invalid_capability", "Invalid managed provider capability token.");
  }

  const result = await ddb.send(
    new GetCommand({
      TableName: getConfig().managedProviderCapabilityTokensTable,
      Key: { tokenHash: tokenHash(token) },
      ConsistentRead: true,
    }),
  );
  const item = result.Item as ManagedProviderCapabilityTokenItem | undefined;
  if (!item || item.providerId !== metadata.providerId) {
    throw new HttpError(401, "invalid_capability", "Invalid managed provider capability token.");
  }
  if (item.revokedAt) {
    throw new HttpError(401, "capability_revoked", "Managed provider capability token has been revoked.");
  }
  if (item.expiresAt <= Math.floor(Date.now() / 1000)) {
    throw new HttpError(401, "capability_expired", "Managed provider capability token has expired.");
  }
  const rawPath = event.rawPath || "/";
  if (!rawPath.startsWith(item.allowedPrefix)) {
    throw new HttpError(403, "capability_scope_denied", "Managed provider capability does not allow this endpoint.", {
      allowedPrefix: item.allowedPrefix,
      path: rawPath,
    });
  }

  await ddb.send(
    new UpdateCommand({
      TableName: getConfig().managedProviderCapabilityTokensTable,
      Key: { tokenHash: item.tokenHash },
      UpdateExpression: "SET lastSeenAt = :now",
      ExpressionAttributeValues: {
        ":now": new Date().toISOString(),
      },
    }),
  );

  return {
    userId: item.userId,
    integrationId: item.integrationId,
    providerId: item.providerId,
    allowedPrefix: item.allowedPrefix,
  };
}

export async function getManagedProviderConnection(
  userId: string,
  integrationId: string,
): Promise<ManagedProviderConnectionItem | undefined> {
  const result = await ddb.send(
    new GetCommand({
      TableName: getConfig().managedProviderConnectionsTable,
      Key: { userId, integrationId },
      ConsistentRead: true,
    }),
  );
  return result.Item as ManagedProviderConnectionItem | undefined;
}

export async function getManagedProviderConnectionView(input: {
  userId: string;
  providerId: string;
  integrationId: string;
}): Promise<ManagedProviderConnectionView> {
  const integrationId = requireIntegrationId(input.integrationId);
  const connection = await getManagedProviderConnection(input.userId, integrationId);
  if (!connection || connection.providerId !== input.providerId) {
    return {
      providerId: input.providerId,
      integrationId,
      status: "not_connected",
    };
  }
  return {
    providerId: connection.providerId,
    integrationId: connection.integrationId,
    status: connection.status,
    providerSubject: connection.providerSubject,
    providerEmail: connection.providerEmail,
    grantedScopes: connection.grantedScopes,
    lastRefreshAt: connection.lastRefreshAt,
    lastError: connection.lastError,
    createdAt: connection.createdAt,
    updatedAt: connection.updatedAt,
  };
}

export async function putManagedProviderConnection(input: {
  userId: string;
  integrationId: string;
  providerId: string;
  status?: ManagedProviderConnectionStatus;
  providerSubject?: string;
  providerEmail?: string;
  grantedScopes?: string[];
  encryptedTokenEnvelope?: string;
  lastRefreshAt?: string;
  lastError?: string;
}): Promise<ManagedProviderConnectionItem> {
  const now = new Date().toISOString();
  const item: ManagedProviderConnectionItem = {
    userId: input.userId,
    integrationId: requireIntegrationId(input.integrationId),
    providerId: input.providerId,
    status: input.status ?? "connected",
    providerSubject: input.providerSubject,
    providerEmail: input.providerEmail,
    grantedScopes: input.grantedScopes,
    encryptedTokenEnvelope: input.encryptedTokenEnvelope,
    lastRefreshAt: input.lastRefreshAt,
    lastError: input.lastError,
    createdAt: now,
    updatedAt: now,
  };
  await ddb.send(
    new PutCommand({
      TableName: getConfig().managedProviderConnectionsTable,
      Item: item,
    }),
  );
  return item;
}

export async function updateManagedProviderConnectionTokens(input: {
  userId: string;
  integrationId: string;
  providerId: string;
  encryptedTokenEnvelope: string;
  grantedScopes?: string[];
  lastRefreshAt?: string;
  lastError?: string;
  status?: ManagedProviderConnectionStatus;
}): Promise<void> {
  const names: Record<string, string> = {
    "#status": "status",
  };
  const values: Record<string, unknown> = {
    ":providerId": input.providerId,
    ":status": input.status ?? "connected",
    ":encryptedTokenEnvelope": input.encryptedTokenEnvelope,
    ":updatedAt": new Date().toISOString(),
  };
  const sets = [
    "#status = :status",
    "encryptedTokenEnvelope = :encryptedTokenEnvelope",
    "updatedAt = :updatedAt",
  ];

  if (input.grantedScopes) {
    sets.push("grantedScopes = :grantedScopes");
    values[":grantedScopes"] = input.grantedScopes;
  }
  if (input.lastRefreshAt) {
    sets.push("lastRefreshAt = :lastRefreshAt");
    values[":lastRefreshAt"] = input.lastRefreshAt;
  }
  if (input.lastError) {
    sets.push("lastError = :lastError");
    values[":lastError"] = input.lastError;
  }

  await ddb.send(
    new UpdateCommand({
      TableName: getConfig().managedProviderConnectionsTable,
      Key: {
        userId: input.userId,
        integrationId: requireIntegrationId(input.integrationId),
      },
      UpdateExpression: `SET ${sets.join(", ")}`,
      ConditionExpression: "attribute_exists(userId) AND providerId = :providerId",
      ExpressionAttributeNames: names,
      ExpressionAttributeValues: values,
    }),
  );
}

export function requireIntegrationId(value: unknown): string {
  if (typeof value !== "string" || !INTEGRATION_ID_PATTERN.test(value)) {
    throw new HttpError(400, "invalid_integration_id", "Managed provider requests require a valid integrationId.");
  }
  return value;
}

function readJsonBody<T>(event: APIGatewayProxyEventV2): T {
  if (!event.body) return {} as T;
  const text = event.isBase64Encoded
    ? Buffer.from(event.body, "base64").toString("utf8")
    : event.body;
  return JSON.parse(text) as T;
}

function randomToken(bytes: number): string {
  return randomBytes(bytes).toString("base64url");
}

function tokenHash(token: string): string {
  return createHash("sha256").update(token).digest("base64url");
}
