import {
  getManagedProviderConnection,
  putManagedProviderConnection,
  updateManagedProviderConnectionTokens,
  type ManagedProviderConnectionItem,
} from "../../managed-provider-auth";
import { getConfig } from "../../config";
import { HttpError } from "../../http";
import { getAppSecretValue } from "../../secrets";
import { decryptJson, encryptJson } from "../../token-encryption";

const OURA_TOKEN_ENDPOINT = "https://api.ouraring.com/oauth/token";
const REFRESH_SKEW_MS = 60 * 1000;

export interface OuraTokenVault {
  accessToken: string;
  refreshToken?: string;
  tokenType: string;
  expiresAt?: number;
  scope?: string;
  obtainedAt: string;
}

interface OuraTokenResponse {
  access_token?: string;
  refresh_token?: string;
  token_type?: string;
  expires_in?: number;
  scope?: string;
  error?: string;
  error_description?: string;
}

export async function exchangeOuraCode(code: string): Promise<OuraTokenVault> {
  const oauth = await ouraOAuthConfig();
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: oauth.redirectUri,
    client_id: oauth.clientId,
    client_secret: oauth.clientSecret,
  });
  return requestOuraToken(body, "oura_token_exchange_failed");
}

export async function getFreshOuraAccessToken(input: {
  userId: string;
  integrationId: string;
  providerId: string;
}): Promise<string> {
  const connection = await getManagedProviderConnection(input.userId, input.integrationId);
  if (!connection || connection.providerId !== input.providerId || connection.status !== "connected") {
    throw new HttpError(409, "managed_provider_not_connected", "Oura is not connected for this integration.", {
      providerId: input.providerId,
      integrationId: input.integrationId,
    });
  }
  if (!connection.encryptedTokenEnvelope) {
    throw new HttpError(409, "managed_provider_needs_reconnect", "Oura connection has no token vault.", {
      providerId: input.providerId,
      integrationId: input.integrationId,
    });
  }

  let vault = await decryptOuraVault(connection);
  if (vault.expiresAt && vault.expiresAt - Date.now() <= REFRESH_SKEW_MS) {
    vault = await refreshAndStoreOuraVault(connection, vault);
  }
  return vault.accessToken;
}

export async function storeOuraConnection(input: {
  userId: string;
  integrationId: string;
  providerId: string;
  token: OuraTokenVault;
}): Promise<void> {
  const encryptedTokenEnvelope = await encryptOuraVault(input.userId, input.integrationId, input.token);
  await putManagedProviderConnection({
    userId: input.userId,
    integrationId: input.integrationId,
    providerId: input.providerId,
    status: "connected",
    grantedScopes: scopesFromToken(input.token),
    encryptedTokenEnvelope,
    lastRefreshAt: new Date().toISOString(),
  });
}

export async function refreshOuraAfterUnauthorized(input: {
  userId: string;
  integrationId: string;
  providerId: string;
}): Promise<string> {
  const connection = await getManagedProviderConnection(input.userId, input.integrationId);
  if (!connection?.encryptedTokenEnvelope || connection.providerId !== input.providerId) {
    throw new HttpError(409, "managed_provider_needs_reconnect", "Oura connection needs reconnect.", {
      providerId: input.providerId,
      integrationId: input.integrationId,
    });
  }
  const vault = await decryptOuraVault(connection);
  return (await refreshAndStoreOuraVault(connection, vault)).accessToken;
}

export async function ouraOAuthConfig(): Promise<{
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}> {
  return {
    clientId: await getAppSecretValue("OURA_CLIENT_ID"),
    clientSecret: await getAppSecretValue("OURA_CLIENT_SECRET"),
    redirectUri: `${getConfig().apiOrigin}/providers/oura/oauth/callback`,
  };
}

async function refreshAndStoreOuraVault(
  connection: ManagedProviderConnectionItem,
  vault: OuraTokenVault,
): Promise<OuraTokenVault> {
  if (!vault.refreshToken) {
    throw new HttpError(409, "managed_provider_needs_reconnect", "Oura refresh token is missing.", {
      providerId: connection.providerId,
      integrationId: connection.integrationId,
    });
  }
  const oauth = await ouraOAuthConfig();
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: vault.refreshToken,
    client_id: oauth.clientId,
    client_secret: oauth.clientSecret,
  });
  const refreshed = await requestOuraToken(body, "oura_token_refresh_failed");
  const next = {
    ...refreshed,
    refreshToken: refreshed.refreshToken ?? vault.refreshToken,
  };
  await updateManagedProviderConnectionTokens({
    userId: connection.userId,
    integrationId: connection.integrationId,
    providerId: connection.providerId,
    encryptedTokenEnvelope: await encryptOuraVault(connection.userId, connection.integrationId, next),
    grantedScopes: scopesFromToken(next),
    lastRefreshAt: new Date().toISOString(),
    status: "connected",
  });
  return next;
}

async function requestOuraToken(body: URLSearchParams, code: string): Promise<OuraTokenVault> {
  const response = await fetch(OURA_TOKEN_ENDPOINT, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body,
  });
  const text = await response.text();
  const data = text ? JSON.parse(text) as OuraTokenResponse : {};
  if (!response.ok) {
    throw new HttpError(502, code, "Oura OAuth token endpoint returned an error.", {
      status: response.status,
      error: data.error,
      errorDescription: data.error_description,
    });
  }
  if (!data.access_token) {
    throw new HttpError(502, code, "Oura OAuth token endpoint returned no access token.");
  }
  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    tokenType: data.token_type ?? "Bearer",
    expiresAt: typeof data.expires_in === "number" ? Date.now() + data.expires_in * 1000 : undefined,
    scope: data.scope,
    obtainedAt: new Date().toISOString(),
  };
}

async function encryptOuraVault(
  userId: string,
  integrationId: string,
  vault: OuraTokenVault,
): Promise<string> {
  return encryptJson(vault, vaultAad(userId, integrationId));
}

async function decryptOuraVault(connection: ManagedProviderConnectionItem): Promise<OuraTokenVault> {
  if (!connection.encryptedTokenEnvelope) {
    throw new Error("Missing encrypted Oura token envelope");
  }
  return decryptJson<OuraTokenVault>(
    connection.encryptedTokenEnvelope,
    vaultAad(connection.userId, connection.integrationId),
  );
}

function vaultAad(userId: string, integrationId: string): string {
  return `managed-provider:oura:${userId}:${integrationId}`;
}

function scopesFromToken(token: OuraTokenVault): string[] | undefined {
  return token.scope?.split(/\s+/).filter(Boolean);
}
