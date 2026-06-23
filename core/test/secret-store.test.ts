import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { openDatabases } from "../src/db";
import {
  AuthCredentialStore,
  ConnectorAuthManager,
  SqliteEncryptedSecretStore,
  createVaultKey,
  encodeVaultKey,
} from "../src/connectors/auth";
import type { ConnectorIntegration } from "../src/connectors";

describe("Secret store and OAuth broker", () => {
  let workspace: string;
  let opened: ReturnType<typeof openDatabases>;

  beforeEach(() => {
    workspace = mkdtempSync(join(tmpdir(), "adiabatic-auth-test-"));
    mkdirSync(join(workspace, ".adiabatic"), { recursive: true });
    opened = openDatabases(workspace);
  });

  afterEach(() => {
    opened.close();
    rmSync(workspace, { recursive: true, force: true });
  });

  test("encrypts secret values in system db", async () => {
    const key = createVaultKey();
    const store = new SqliteEncryptedSecretStore(opened.systemDb, key);

    await store.set("credential-1", "top-secret-token");

    const row = opened.systemDb.prepare(
      "SELECT ciphertext, nonce, algorithm FROM auth_secret_items WHERE id = ?",
    ).get("credential-1") as { ciphertext: string; nonce: string; algorithm: string };
    expect(row.algorithm).toBe("aes-256-gcm");
    expect(row.ciphertext).not.toContain("top-secret-token");
    expect(await store.get("credential-1")).toBe("top-secret-token");

    const reopened = new SqliteEncryptedSecretStore(opened.systemDb, encodeVaultKey(key));
    expect(await reopened.get("credential-1")).toBe("top-secret-token");
    const wrongKey = new SqliteEncryptedSecretStore(opened.systemDb, createVaultKey());
    await expect(wrongKey.get("credential-1")).rejects.toThrow();
  });

  test("api key connect creates credential metadata without D0 events", async () => {
    const manager = new ConnectorAuthManager(
      new SqliteEncryptedSecretStore(opened.systemDb, createVaultKey()),
      { credentialStore: new AuthCredentialStore(opened.systemDb) },
    );

    await manager.setToken("auth-ref", "secret-token", {
      ownerType: "connector",
      ownerId: "integration-1",
    });

    const credential = manager.credential("auth-ref");
    expect(credential).toMatchObject({
      id: "auth-ref",
      kind: "apiKey",
      ownerType: "connector",
      ownerId: "integration-1",
      status: "active",
    });
    expect(await manager.createHandle({ type: "apiKey" }, integration("auth-ref")).getToken()).toBe("secret-token");
    expect(opened.dataDb.prepare("SELECT * FROM events WHERE type LIKE 'auth.%'").all()).toEqual([]);
  });

  test("oauth callback stores token and attempt status", async () => {
    const manager = new ConnectorAuthManager(
      new SqliteEncryptedSecretStore(opened.systemDb, createVaultKey()),
      {
        credentialStore: new AuthCredentialStore(opened.systemDb),
        fetchImpl: async (_url, init) => {
          expect(String(init?.body)).toContain("grant_type=authorization_code");
          return jsonResponse({ access_token: "access-1", refresh_token: "refresh-1", expires_in: 3600 });
        },
      },
    );
    const auth = {
      type: "oauth2-public" as const,
      authorizationEndpoint: "https://provider.example/authorize",
      tokenEndpoint: "https://provider.example/token",
      clientId: "client-id",
      scope: ["read", "write"],
    };

    const started = manager.startOAuth(integration("oauth-ref"), auth, {
      redirectUri: "http://127.0.0.1:32123/oauth/callback",
    });
    const authUrl = new URL(started.authorizationUrl);
    expect(authUrl.searchParams.get("redirect_uri")).toBe("http://127.0.0.1:32123/oauth/callback");
    expect(authUrl.searchParams.get("code_challenge_method")).toBe("S256");

    const result = await manager.completeOAuthCallback(new URLSearchParams({
      state: authUrl.searchParams.get("state")!,
      code: "code-1",
    }));

    expect(result).toMatchObject({ status: "connected", credentialId: "oauth-ref", authRef: "oauth-ref" });
    expect(manager.getOAuthAttempt("integration-1", started.attemptId)).toMatchObject({
      status: "connected",
      credentialId: "oauth-ref",
    });
    expect(await manager.createHandle(auth, integration("oauth-ref")).getToken()).toBe("access-1");
    expect(opened.dataDb.prepare("SELECT * FROM events WHERE type LIKE 'auth.%'").all()).toEqual([]);
  });

  test("oauth refresh single-flights concurrent getToken calls", async () => {
    let calls = 0;
    const manager = new ConnectorAuthManager(
      new SqliteEncryptedSecretStore(opened.systemDb, createVaultKey()),
      {
        credentialStore: new AuthCredentialStore(opened.systemDb),
        fetchImpl: async (_url, init) => {
          calls++;
          const body = String(init?.body);
          if (body.includes("authorization_code")) {
            return jsonResponse({ access_token: "old", refresh_token: "refresh", expires_in: -1 });
          }
          return jsonResponse({ access_token: "new", refresh_token: "rotated", expires_in: 3600 });
        },
      },
    );
    const auth = {
      type: "oauth2-public" as const,
      authorizationEndpoint: "https://provider.example/authorize",
      tokenEndpoint: "https://provider.example/token",
      clientId: "client-id",
    };
    const started = manager.startOAuth(integration("oauth-ref"), auth, {
      redirectUri: "http://127.0.0.1:32123/oauth/callback",
    });
    const state = new URL(started.authorizationUrl).searchParams.get("state")!;
    await manager.completeOAuthCallback(new URLSearchParams({ state, code: "code-1" }));

    const handle = manager.createHandle(auth, integration("oauth-ref"));
    await expect(Promise.all([handle.getToken(), handle.getToken()])).resolves.toEqual(["new", "new"]);
    expect(calls).toBe(2);
  });

  test("BYO public oauth: user-supplied clientId flows through start, exchange, and refresh", async () => {
    const seen: string[] = [];
    const manager = new ConnectorAuthManager(
      new SqliteEncryptedSecretStore(opened.systemDb, createVaultKey()),
      {
        credentialStore: new AuthCredentialStore(opened.systemDb),
        fetchImpl: async (_url, init) => {
          const body = String(init?.body);
          seen.push(body);
          if (body.includes("authorization_code")) {
            return jsonResponse({ access_token: "byo-access", refresh_token: "byo-refresh", expires_in: -1 });
          }
          return jsonResponse({ access_token: "byo-access-2", expires_in: 3600 });
        },
      },
    );
    const auth = {
      type: "oauth2-byo-public" as const,
      authorizationEndpoint: "https://provider.example/authorize",
      tokenEndpoint: "https://provider.example/token",
    };
    const started = manager.startOAuth(integration("byo-ref"), auth, {
      redirectUri: "http://127.0.0.1:32123/oauth/callback",
      clientId: "byo-client",
    });
    expect(new URL(started.authorizationUrl).searchParams.get("client_id")).toBe("byo-client");

    const state = new URL(started.authorizationUrl).searchParams.get("state")!;
    await manager.completeOAuthCallback(new URLSearchParams({ state, code: "code-1" }));
    expect(seen.some((b) => b.includes("authorization_code") && b.includes("client_id=byo-client"))).toBe(true);

    // Token is expired, so getToken refreshes — and refresh must use the
    // persisted clientId even though the manifest auth has none.
    const token = await manager.createHandle(auth, integration("byo-ref")).getToken();
    expect(token).toBe("byo-access-2");
    expect(seen.some((b) => b.includes("refresh_token") && b.includes("client_id=byo-client"))).toBe(true);
  });

  test("BYO confidential oauth posts user client secret for code exchange and refresh", async () => {
    const seen: string[] = [];
    const manager = new ConnectorAuthManager(
      new SqliteEncryptedSecretStore(opened.systemDb, createVaultKey()),
      {
        credentialStore: new AuthCredentialStore(opened.systemDb),
        fetchImpl: async (_url, init) => {
          const body = String(init?.body);
          seen.push(body);
          if (body.includes("authorization_code")) {
            return jsonResponse({ access_token: "old", refresh_token: "refresh", expires_in: -1 });
          }
          return jsonResponse({ access_token: "new", expires_in: 3600 });
        },
      },
    );
    const auth = {
      type: "oauth2-byo-confidential" as const,
      authorizationEndpoint: "https://provider.example/authorize",
      tokenEndpoint: "https://provider.example/token",
      tokenEndpointAuthMethod: "client_secret_post" as const,
    };
    const started = manager.startOAuth(integration("confidential-ref"), auth, {
      redirectUri: "http://127.0.0.1:32123/oauth/callback",
      clientId: "byo-client",
      clientSecret: "byo-secret",
    });
    const state = new URL(started.authorizationUrl).searchParams.get("state")!;
    await manager.completeOAuthCallback(new URLSearchParams({ state, code: "code-1" }));
    expect(seen.some((b) => b.includes("authorization_code") && b.includes("client_secret=byo-secret"))).toBe(true);

    await expect(manager.createHandle(auth, integration("confidential-ref")).getToken()).resolves.toBe("new");
    expect(seen.some((b) => b.includes("refresh_token") && b.includes("client_secret=byo-secret"))).toBe(true);
  });

  test("BYO confidential oauth supports client_secret_basic", async () => {
    const authHeaders: string[] = [];
    const manager = new ConnectorAuthManager(
      new SqliteEncryptedSecretStore(opened.systemDb, createVaultKey()),
      {
        credentialStore: new AuthCredentialStore(opened.systemDb),
        fetchImpl: async (_url, init) => {
          const headers = new Headers(init?.headers);
          authHeaders.push(headers.get("authorization") ?? "");
          expect(String(init?.body)).not.toContain("client_secret=");
          return jsonResponse({ access_token: "basic-access", refresh_token: "basic-refresh", expires_in: 3600 });
        },
      },
    );
    const auth = {
      type: "oauth2-byo-confidential" as const,
      authorizationEndpoint: "https://provider.example/authorize",
      tokenEndpoint: "https://provider.example/token",
      tokenEndpointAuthMethod: "client_secret_basic" as const,
    };
    const started = manager.startOAuth(integration("basic-ref"), auth, {
      redirectUri: "http://127.0.0.1:32123/oauth/callback",
      clientId: "byo-client",
      clientSecret: "byo-secret",
    });
    const state = new URL(started.authorizationUrl).searchParams.get("state")!;
    await manager.completeOAuthCallback(new URLSearchParams({ state, code: "code-1" }));

    expect(authHeaders).toEqual([
      `Basic ${Buffer.from("byo-client:byo-secret").toString("base64")}`,
    ]);
  });

  test("hosted oauth validates but is not startable in this build", () => {
    const manager = new ConnectorAuthManager();
    expect(() =>
      manager.startOAuth(integration("hosted-ref"), {
        type: "oauth2-hosted",
        connectEndpoint: "https://auth.adiabatic.com/connect/demo",
      }, {
        redirectUri: "http://127.0.0.1:32123/oauth/callback",
      })
    ).toThrow("hosted OAuth is not available in this build");
  });
});

function integration(authRef: string): ConnectorIntegration {
  return {
    id: "integration-1",
    connectorId: "connector-1",
    integrationKey: undefined,
    enabled: true,
    status: "idle",
    setupStatus: "ready",
    trustStatus: "custom",
    scheduleCron: undefined,
    nextRunAt: undefined,
    packageHash: undefined,
    config: undefined,
    syncState: undefined,
    requirementsStatus: undefined,
    authRef,
    lastError: undefined,
    lastRunAt: undefined,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
}

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}
