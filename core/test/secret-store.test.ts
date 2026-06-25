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
          const body = String(init?.body);
          expect(body).toContain("grant_type=authorization_code");
          expect(body).not.toContain("client_secret=");
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
      redirectUri: "http://localhost:32123/oauth/callback",
    });
    const authUrl = new URL(started.authorizationUrl);
    expect(authUrl.searchParams.get("redirect_uri")).toBe("http://localhost:32123/oauth/callback");
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
      redirectUri: "http://localhost:32123/oauth/callback",
    });
    const state = new URL(started.authorizationUrl).searchParams.get("state")!;
    await manager.completeOAuthCallback(new URLSearchParams({ state, code: "code-1" }));

    const handle = manager.createHandle(auth, integration("oauth-ref"));
    await expect(Promise.all([handle.getToken(), handle.getToken()])).resolves.toEqual(["new", "new"]);
    expect(calls).toBe(2);
  });

  test("managed provider start builds the Lamarck connect URL", () => {
    const manager = new ConnectorAuthManager();
    const started = manager.startManagedProvider(integration("managed-ref"), {
      type: "managedProvider",
      providerId: "oura",
    }, {
      authOrigin: "https://auth.lamarck.ai",
    });
    expect(started.authorizationUrl.startsWith("https://auth.lamarck.ai/connect/oura?")).toBe(true);
    expect(started.redirectUri).toBeUndefined();
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
    warnings: undefined,
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
