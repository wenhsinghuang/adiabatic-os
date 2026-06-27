import type { Database } from "bun:sqlite";
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  timingSafeEqual,
} from "crypto";
import {
  isOAuthAuthSpec,
  runtimeAuthType,
  type ConnectorAuthHandle,
  type ConnectorAuthSpec,
  type ConnectorIntegration,
  type ConnectorManagedProviderAuthSpec,
  type ConnectorOAuthAuthSpec,
  type ConnectorOAuthDirectAuthSpec,
} from "./types";

export type AuthCredentialStatus = "active" | "expired" | "revoked" | "refresh_failed";
export type OAuthAttemptStatus = "pending" | "connected" | "failed" | "expired";
export type AuthCredentialKind = "apiKey" | "oauth2" | "managedProvider";

export interface ConnectorSecretStore {
  get(ref: string): Promise<string | undefined>;
  set(ref: string, value: string): Promise<void>;
  delete(ref: string): Promise<void>;
  has?(ref: string): Promise<boolean>;
}

export interface AuthCredentialRecord {
  id: string;
  kind: AuthCredentialKind;
  ownerType: string;
  ownerId: string;
  scopes: string[] | undefined;
  status: AuthCredentialStatus;
  secretItemId: string;
  expiresAt: number | undefined;
  metadata: Record<string, unknown> | undefined;
  statusChangedAt: number;
  createdAt: number;
  updatedAt: number;
}

export interface OAuthStartResult {
  authorizationUrl: string;
  attemptId: string;
  redirectUri?: string;
  expiresAt: number;
}

export interface OAuthAttemptView {
  status: OAuthAttemptStatus;
  integrationId?: string;
  authRef?: string;
  credentialId?: string;
  error?: string;
}

type SecretPayload =
  | { kind: "apiKey"; value: string }
  | {
      kind: "oauth2";
      accessToken: string;
      refreshToken?: string;
      expiresAt?: number;
      tokenType?: string;
    }
  | {
      kind: "managedProvider";
      providerId: string;
      accessToken: string;
      expiresAt?: number;
    };

interface CredentialUpsertInput {
  id: string;
  kind: AuthCredentialKind;
  ownerType: string;
  ownerId: string;
  scopes?: string[];
  status?: AuthCredentialStatus;
  secretItemId: string;
  expiresAt?: number;
  metadata?: Record<string, unknown>;
}

interface OAuthAttempt {
  id: string;
  integrationId: string;
  authRef: string;
  auth: ConnectorOAuthDirectAuthSpec;
  ownerType: string;
  ownerId: string;
  clientId: string;
  codeVerifier: string;
  state: string;
  redirectUri: string;
  expiresAt: number;
  status: OAuthAttemptStatus;
  credentialId?: string;
  error?: string;
}

interface ManagedProviderAttempt {
  id: string;
  integrationId: string;
  authRef: string;
  providerId: string;
  expiresAt: number;
  status: OAuthAttemptStatus;
  credentialId?: string;
  error?: string;
}

interface TokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  expires_at?: number;
  token_type?: string;
  error?: string;
  error_description?: string;
}

export class MemoryConnectorSecretStore implements ConnectorSecretStore {
  private values = new Map<string, string>();

  async get(ref: string): Promise<string | undefined> {
    return this.values.get(ref);
  }

  async set(ref: string, value: string): Promise<void> {
    this.values.set(ref, value);
  }

  async delete(ref: string): Promise<void> {
    this.values.delete(ref);
  }

  async has(ref: string): Promise<boolean> {
    return this.values.has(ref);
  }
}

export class SqliteEncryptedSecretStore implements ConnectorSecretStore {
  private key: Buffer;

  constructor(private systemDb: Database, vaultKey: string | Uint8Array) {
    this.key = normalizeVaultKey(vaultKey);
  }

  async get(ref: string): Promise<string | undefined> {
    const row = this.systemDb.prepare(
      "SELECT ciphertext, nonce, algorithm FROM auth_secret_items WHERE id = ?",
    ).get(ref) as { ciphertext: string; nonce: string; algorithm: string } | null;
    if (!row) return undefined;
    if (row.algorithm !== "aes-256-gcm") {
      throw new Error(`Unsupported secret algorithm: ${row.algorithm}`);
    }
    return decryptString({
      key: this.key,
      ciphertext: row.ciphertext,
      nonce: row.nonce,
    });
  }

  async set(ref: string, value: string): Promise<void> {
    const now = Date.now();
    const encrypted = encryptString({ key: this.key, plaintext: value });
    this.systemDb.prepare(
      `INSERT INTO auth_secret_items (id, ciphertext, nonce, algorithm, created_at, updated_at)
       VALUES (?, ?, ?, 'aes-256-gcm', ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         ciphertext = excluded.ciphertext,
         nonce = excluded.nonce,
         algorithm = excluded.algorithm,
         updated_at = excluded.updated_at`,
    ).run(ref, encrypted.ciphertext, encrypted.nonce, now, now);
  }

  async delete(ref: string): Promise<void> {
    this.systemDb.prepare("DELETE FROM auth_secret_items WHERE id = ?").run(ref);
  }

  async has(ref: string): Promise<boolean> {
    const row = this.systemDb.prepare(
      "SELECT 1 AS present FROM auth_secret_items WHERE id = ?",
    ).get(ref);
    return Boolean(row);
  }
}

export class AuthCredentialStore {
  constructor(private systemDb: Database) {}

  upsert(input: CredentialUpsertInput): AuthCredentialRecord {
    const now = Date.now();
    const existing = this.get(input.id);
    const nextStatus = input.status ?? existing?.status ?? "active";
    const statusChangedAt = existing && existing.status === nextStatus
      ? existing.statusChangedAt
      : now;
    this.systemDb.prepare(
      `INSERT INTO auth_credentials
       (id, kind, account_id, owner_type, owner_id, scopes_json, status, secret_item_id,
        expires_at, metadata, status_changed_at, created_at, updated_at)
       VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         kind = excluded.kind,
         owner_type = excluded.owner_type,
         owner_id = excluded.owner_id,
         scopes_json = excluded.scopes_json,
         status = excluded.status,
         secret_item_id = excluded.secret_item_id,
         expires_at = excluded.expires_at,
         metadata = excluded.metadata,
         status_changed_at = excluded.status_changed_at,
         updated_at = excluded.updated_at`,
    ).run(
      input.id,
      input.kind,
      input.ownerType,
      input.ownerId,
      input.scopes ? JSON.stringify(input.scopes) : null,
      nextStatus,
      input.secretItemId,
      input.expiresAt ?? null,
      input.metadata ? JSON.stringify(input.metadata) : null,
      statusChangedAt,
      existing?.createdAt ?? now,
      now,
    );
    return this.get(input.id)!;
  }

  get(id: string): AuthCredentialRecord | undefined {
    const row = this.systemDb.prepare("SELECT * FROM auth_credentials WHERE id = ?").get(id) as
      | CredentialRow
      | null;
    return row ? rowToCredential(row) : undefined;
  }

  setStatus(id: string, status: AuthCredentialStatus, metadata?: Record<string, unknown>): void {
    const now = Date.now();
    const current = this.get(id);
    const mergedMetadata = metadata === undefined
      ? current?.metadata
      : { ...(current?.metadata ?? {}), ...metadata };
    this.systemDb.prepare(
      `UPDATE auth_credentials
       SET status = ?,
           metadata = ?,
           status_changed_at = CASE WHEN status = ? THEN status_changed_at ELSE ? END,
           updated_at = ?
       WHERE id = ?`,
    ).run(
      status,
      mergedMetadata ? JSON.stringify(mergedMetadata) : null,
      status,
      now,
      now,
      id,
    );
  }

  delete(id: string): void {
    const credential = this.get(id);
    this.systemDb.prepare("DELETE FROM auth_credentials WHERE id = ?").run(id);
    if (credential) {
      this.systemDb.prepare("DELETE FROM auth_secret_items WHERE id = ?").run(credential.secretItemId);
    }
  }
}

interface ConnectorAuthManagerOptions {
  credentialStore?: AuthCredentialStore;
  fetchImpl?: typeof fetch;
  refreshSkewMs?: number;
  attemptTtlMs?: number;
}

export class ConnectorAuthManager {
  private credentialStore: AuthCredentialStore | undefined;
  private fetchImpl: typeof fetch;
  private refreshSkewMs: number;
  private attemptTtlMs: number;
  private attemptsById = new Map<string, OAuthAttempt>();
  private attemptsByState = new Map<string, OAuthAttempt>();
  private managedAttemptsById = new Map<string, ManagedProviderAttempt>();
  private refreshFlights = new Map<string, Promise<string>>();

  constructor(
    private secrets: ConnectorSecretStore = new MemoryConnectorSecretStore(),
    opts: ConnectorAuthManagerOptions = {},
  ) {
    this.credentialStore = opts.credentialStore;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.refreshSkewMs = opts.refreshSkewMs ?? 60_000;
    this.attemptTtlMs = opts.attemptTtlMs ?? 10 * 60_000;
  }

  async setToken(
    authRef: string,
    token: string,
    opts?: { ownerType?: string; ownerId?: string; scopes?: string[]; metadata?: Record<string, unknown> },
  ): Promise<void> {
    await this.writePayload(authRef, { kind: "apiKey", value: token });
    this.credentialStore?.upsert({
      id: authRef,
      kind: "apiKey",
      ownerType: opts?.ownerType ?? "connector",
      ownerId: opts?.ownerId ?? authRef,
      scopes: opts?.scopes,
      status: "active",
      secretItemId: authRef,
      metadata: opts?.metadata,
    });
  }

  async deleteToken(authRef: string): Promise<void> {
    this.credentialStore?.delete(authRef);
    if (!this.credentialStore) {
      await this.secrets.delete(authRef);
    }
  }

  async hasToken(authRef: string): Promise<boolean> {
    const credential = this.credentialStore?.get(authRef);
    if (credential && (credential.status === "revoked" || credential.status === "refresh_failed")) {
      return false;
    }
    if (this.secrets.has) return this.secrets.has(authRef);
    return Boolean(await this.secrets.get(authRef));
  }

  credential(authRef: string): AuthCredentialRecord | undefined {
    return this.credentialStore?.get(authRef);
  }

  startOAuth(
    integration: ConnectorIntegration,
    auth: ConnectorOAuthAuthSpec,
    input: { redirectUri: string },
  ): OAuthStartResult {
    const codeVerifier = base64url(randomBytes(32));
    const state = base64url(randomBytes(32));
    const attemptId = base64url(randomBytes(16));
    const expiresAt = Date.now() + this.attemptTtlMs;
    const authRef = integration.authRef ?? `connector-integration:${integration.id}:auth`;
    const attempt: OAuthAttempt = {
      id: attemptId,
      integrationId: integration.id,
      authRef,
      auth,
      ownerType: "connector",
      ownerId: integration.id,
      clientId: auth.clientId,
      codeVerifier,
      state,
      redirectUri: input.redirectUri,
      expiresAt,
      status: "pending",
    };
    this.attemptsById.set(attemptId, attempt);
    this.attemptsByState.set(state, attempt);

    const url = new URL(auth.authorizationEndpoint);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("client_id", auth.clientId);
    url.searchParams.set("redirect_uri", input.redirectUri);
    url.searchParams.set("state", state);
    url.searchParams.set("code_challenge", pkceChallenge(codeVerifier));
    url.searchParams.set("code_challenge_method", "S256");
    if (auth.scope?.length) {
      url.searchParams.set("scope", auth.scope.join(" "));
    }

    return {
      authorizationUrl: url.toString(),
      attemptId,
      redirectUri: input.redirectUri,
      expiresAt,
    };
  }

  startManagedProvider(
    integration: ConnectorIntegration,
    auth: ConnectorManagedProviderAuthSpec,
    input: { appOrigin: string },
  ): OAuthStartResult {
    const attemptId = base64url(randomBytes(16));
    const expiresAt = Date.now() + this.attemptTtlMs;
    const authRef = integration.authRef ?? `connector-integration:${integration.id}:auth`;
    const attempt: ManagedProviderAttempt = {
      id: attemptId,
      integrationId: integration.id,
      authRef,
      providerId: auth.providerId,
      expiresAt,
      status: "pending",
    };
    this.managedAttemptsById.set(attemptId, attempt);

    const url = new URL(`/providers/${encodeURIComponent(auth.providerId)}/connect`, normalizeOrigin(input.appOrigin));
    url.searchParams.set("attempt", attemptId);

    return {
      authorizationUrl: url.toString(),
      attemptId,
      expiresAt,
    };
  }

  getOAuthAttempt(integrationId: string, attemptId: string): OAuthAttemptView {
    const attempt = this.attemptsById.get(attemptId);
    if (!attempt) {
      return this.getManagedProviderAttempt(integrationId, attemptId);
    }
    if (attempt.integrationId !== integrationId) {
      return { status: "failed", error: "Auth attempt not found" };
    }
    if (attempt.status === "pending" && Date.now() > attempt.expiresAt) {
      attempt.status = "expired";
      attempt.error = "OAuth attempt expired";
      this.attemptsByState.delete(attempt.state);
    }
    return {
      status: attempt.status,
      integrationId: attempt.integrationId,
      authRef: attempt.authRef,
      credentialId: attempt.credentialId,
      error: attempt.error,
    };
  }

  private getManagedProviderAttempt(integrationId: string, attemptId: string): OAuthAttemptView {
    const attempt = this.managedAttemptsById.get(attemptId);
    if (!attempt || attempt.integrationId !== integrationId) {
      return { status: "failed", error: "Auth attempt not found" };
    }
    if (attempt.status === "pending" && Date.now() > attempt.expiresAt) {
      attempt.status = "expired";
      attempt.error = "Managed provider auth attempt expired";
    }
    return {
      status: attempt.status,
      integrationId: attempt.integrationId,
      authRef: attempt.authRef,
      credentialId: attempt.credentialId,
      error: attempt.error,
    };
  }

  async completeOAuthCallback(params: URLSearchParams): Promise<OAuthAttemptView> {
    const state = params.get("state") ?? "";
    const code = params.get("code") ?? "";
    const providerError = params.get("error");
    const attempt = this.attemptsByState.get(state);
    if (!attempt || attempt.status !== "pending") {
      return { status: "failed", error: "OAuth state is invalid or already used" };
    }
    this.attemptsByState.delete(state);
    if (Date.now() > attempt.expiresAt) {
      attempt.status = "expired";
      attempt.error = "OAuth attempt expired";
      return {
        status: "expired",
        integrationId: attempt.integrationId,
        authRef: attempt.authRef,
        error: attempt.error,
      };
    }
    if (providerError) {
      attempt.status = "failed";
      attempt.error = params.get("error_description") ?? providerError;
      return {
        status: "failed",
        integrationId: attempt.integrationId,
        authRef: attempt.authRef,
        error: attempt.error,
      };
    }
    if (!code) {
      attempt.status = "failed";
      attempt.error = "OAuth callback did not include a code";
      return {
        status: "failed",
        integrationId: attempt.integrationId,
        authRef: attempt.authRef,
        error: attempt.error,
      };
    }

    try {
      const token = await this.exchangeCode(attempt, code);
      await this.persistOAuthToken(attempt, token);
      attempt.status = "connected";
      attempt.credentialId = attempt.authRef;
      return {
        status: "connected",
        integrationId: attempt.integrationId,
        authRef: attempt.authRef,
        credentialId: attempt.authRef,
      };
    } catch (err) {
      attempt.status = "failed";
      attempt.error = err instanceof Error ? err.message : String(err);
      return {
        status: "failed",
        integrationId: attempt.integrationId,
        authRef: attempt.authRef,
        error: attempt.error,
      };
    }
  }

  createHandle(auth: ConnectorAuthSpec, integration: ConnectorIntegration): ConnectorAuthHandle {
    if (auth.type === "none") {
      return { type: "none" };
    }

    const authRef = integration.authRef;
    if (!authRef) {
      throw new Error(`Connector integration ${integration.id} requires auth_ref`);
    }

    return {
      type: runtimeAuthType(auth),
      getToken: async () => {
        const payload = await this.readPayload(authRef);
        if (!payload) {
          throw new Error(`Connector integration ${integration.id} is missing credentials`);
        }
        if (auth.type === "apiKey") {
          if (payload.kind !== "apiKey") {
            throw new Error(`Connector integration ${integration.id} credential kind mismatch`);
          }
          return payload.value;
        }
        if (auth.type === "managedProvider") {
          if (payload.kind !== "managedProvider") {
            throw new Error(`Connector integration ${integration.id} credential kind mismatch`);
          }
          return this.managedProviderAccessToken(authRef, auth, payload);
        }
        if (!isOAuthAuthSpec(auth) || payload.kind !== "oauth2") {
          throw new Error(`Connector integration ${integration.id} credential kind mismatch`);
        }
        return this.oauthAccessToken(authRef, auth, payload);
      },
    };
  }

  private async oauthAccessToken(
    authRef: string,
    auth: ConnectorOAuthAuthSpec,
    payload: Extract<SecretPayload, { kind: "oauth2" }>,
  ): Promise<string> {
    if (!payload.expiresAt || payload.expiresAt - Date.now() > this.refreshSkewMs) {
      return payload.accessToken;
    }
    const existing = this.refreshFlights.get(authRef);
    if (existing) return existing;
    const flight = this.refreshOAuthToken(authRef, auth, payload)
      .finally(() => this.refreshFlights.delete(authRef));
    this.refreshFlights.set(authRef, flight);
    return flight;
  }

  private async managedProviderAccessToken(
    authRef: string,
    auth: ConnectorManagedProviderAuthSpec,
    payload: Extract<SecretPayload, { kind: "managedProvider" }>,
  ): Promise<string> {
    if (payload.providerId !== auth.providerId) {
      throw new Error(`Managed provider credential is for ${payload.providerId}, not ${auth.providerId}`);
    }
    if (!payload.expiresAt || payload.expiresAt - Date.now() > this.refreshSkewMs) {
      return payload.accessToken;
    }
    this.credentialStore?.setStatus(authRef, "refresh_failed", {
      refresh_error: "managed provider token refresh is not implemented in this build",
    });
    throw managedProviderUnavailable();
  }

  private async refreshOAuthToken(
    authRef: string,
    auth: ConnectorOAuthDirectAuthSpec,
    payload: Extract<SecretPayload, { kind: "oauth2" }>,
  ): Promise<string> {
    if (!payload.refreshToken) {
      this.credentialStore?.setStatus(authRef, "refresh_failed", { refresh_error: "missing refresh token" });
      throw new Error("OAuth credential is expired and has no refresh token");
    }
    try {
      const token = await this.exchangeRefresh(auth, payload);
      const nextPayload: Extract<SecretPayload, { kind: "oauth2" }> = {
        ...payload,
        accessToken: requireAccessToken(token),
        refreshToken: token.refresh_token ?? payload.refreshToken,
        expiresAt: tokenExpiresAt(token),
        tokenType: token.token_type ?? payload.tokenType,
      };
      await this.writePayload(authRef, nextPayload);
      const current = this.credentialStore?.get(authRef);
      this.credentialStore?.upsert({
        id: authRef,
        kind: "oauth2",
        ownerType: current?.ownerType ?? "connector",
        ownerId: current?.ownerId ?? authRef,
        scopes: auth.scope,
        status: "active",
        secretItemId: authRef,
        expiresAt: nextPayload.expiresAt,
        metadata: current?.metadata,
      });
      return nextPayload.accessToken;
    } catch (err) {
      this.credentialStore?.setStatus(authRef, "refresh_failed", {
        refresh_error: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }
  }

  private async exchangeCode(attempt: OAuthAttempt, code: string): Promise<TokenResponse> {
    const body = new URLSearchParams();
    body.set("grant_type", "authorization_code");
    body.set("code", code);
    body.set("redirect_uri", attempt.redirectUri);
    body.set("client_id", attempt.clientId);
    body.set("code_verifier", attempt.codeVerifier);
    return this.fetchToken(attempt.auth, body);
  }

  private async exchangeRefresh(
    auth: ConnectorOAuthDirectAuthSpec,
    payload: Extract<SecretPayload, { kind: "oauth2" }>,
  ): Promise<TokenResponse> {
    const body = new URLSearchParams();
    body.set("grant_type", "refresh_token");
    body.set("refresh_token", payload.refreshToken!);
    body.set("client_id", auth.clientId);
    return this.fetchToken(auth, body);
  }

  private async fetchToken(
    auth: ConnectorOAuthDirectAuthSpec,
    body: URLSearchParams,
  ): Promise<TokenResponse> {
    const headers: Record<string, string> = {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    };
    const res = await this.fetchImpl(auth.tokenEndpoint, {
      method: "POST",
      headers,
      body,
    });
    const text = await res.text();
    const data = text ? JSON.parse(text) as TokenResponse : {};
    if (!res.ok || data.error) {
      throw new Error(data.error_description ?? data.error ?? `OAuth token endpoint returned ${res.status}`);
    }
    requireAccessToken(data);
    return data;
  }

  private async persistOAuthToken(attempt: OAuthAttempt, token: TokenResponse): Promise<void> {
    const payload: Extract<SecretPayload, { kind: "oauth2" }> = {
      kind: "oauth2",
      accessToken: requireAccessToken(token),
      refreshToken: token.refresh_token,
      expiresAt: tokenExpiresAt(token),
      tokenType: token.token_type,
    };
    await this.writePayload(attempt.authRef, payload);
    this.credentialStore?.upsert({
      id: attempt.authRef,
      kind: "oauth2",
      ownerType: attempt.ownerType,
      ownerId: attempt.ownerId,
      scopes: attempt.auth.scope,
      status: "active",
      secretItemId: attempt.authRef,
      expiresAt: payload.expiresAt,
      metadata: {
        redirect_uri: attempt.redirectUri,
      },
    });
  }

  private async readPayload(ref: string): Promise<SecretPayload | undefined> {
    const raw = await this.secrets.get(ref);
    if (!raw) return undefined;
    try {
      const parsed = JSON.parse(raw) as SecretPayload;
      if (parsed.kind === "apiKey" || parsed.kind === "oauth2" || parsed.kind === "managedProvider") {
        return parsed;
      }
    } catch {
      return { kind: "apiKey", value: raw };
    }
    throw new Error(`Invalid credential payload for ${ref}`);
  }

  private async writePayload(ref: string, payload: SecretPayload): Promise<void> {
    await this.secrets.set(ref, JSON.stringify(payload));
  }
}

function managedProviderUnavailable(connectorId?: string): Error {
  return new Error(
    connectorId
      ? `Connector ${connectorId} managed provider auth is not available in this build`
      : "Managed provider auth is not available in this build",
  );
}

function normalizeOrigin(origin: string): string {
  const url = new URL(origin);
  url.pathname = "/";
  url.search = "";
  url.hash = "";
  return url.toString();
}

interface CredentialRow {
  id: string;
  kind: AuthCredentialKind;
  owner_type: string;
  owner_id: string;
  scopes_json: string | null;
  status: AuthCredentialStatus;
  secret_item_id: string;
  expires_at: number | null;
  metadata: string | null;
  status_changed_at: number;
  created_at: number;
  updated_at: number;
}

export function encodeVaultKey(key: Uint8Array): string {
  return base64url(Buffer.from(key));
}

export function decodeVaultKey(value: string): Buffer {
  return normalizeVaultKey(value);
}

export function createVaultKey(): Buffer {
  return randomBytes(32);
}

function rowToCredential(row: CredentialRow): AuthCredentialRecord {
  return {
    id: row.id,
    kind: row.kind,
    ownerType: row.owner_type,
    ownerId: row.owner_id,
    scopes: row.scopes_json ? JSON.parse(row.scopes_json) as string[] : undefined,
    status: row.status,
    secretItemId: row.secret_item_id,
    expiresAt: row.expires_at ?? undefined,
    metadata: row.metadata ? JSON.parse(row.metadata) as Record<string, unknown> : undefined,
    statusChangedAt: row.status_changed_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function encryptString(opts: { key: Buffer; plaintext: string }): { ciphertext: string; nonce: string } {
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", opts.key, nonce);
  const encrypted = Buffer.concat([cipher.update(opts.plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    ciphertext: base64url(Buffer.concat([encrypted, tag])),
    nonce: base64url(nonce),
  };
}

function decryptString(opts: { key: Buffer; ciphertext: string; nonce: string }): string {
  const packed = unbase64url(opts.ciphertext);
  if (packed.length < 17) throw new Error("Invalid ciphertext");
  const encrypted = packed.subarray(0, -16);
  const tag = packed.subarray(-16);
  const decipher = createDecipheriv("aes-256-gcm", opts.key, unbase64url(opts.nonce));
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString("utf8");
}

function normalizeVaultKey(value: string | Uint8Array): Buffer {
  const key = typeof value === "string" ? unbase64url(value) : Buffer.from(value);
  if (key.length !== 32) {
    throw new Error("ADIABATIC_VAULT_KEY must decode to 32 bytes");
  }
  return key;
}

function pkceChallenge(verifier: string): string {
  return base64url(createHash("sha256").update(verifier).digest());
}

function requireAccessToken(token: TokenResponse): string {
  if (!token.access_token) {
    throw new Error("OAuth token endpoint did not return an access_token");
  }
  return token.access_token;
}

function tokenExpiresAt(token: TokenResponse): number | undefined {
  if (typeof token.expires_at === "number") return token.expires_at;
  if (typeof token.expires_in === "number") return Date.now() + token.expires_in * 1000;
  return undefined;
}

function base64url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64url");
}

function unbase64url(value: string): Buffer {
  return Buffer.from(value, "base64url");
}

export function constantTimeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}
