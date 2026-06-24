# Auth and Secret Store

Status: current module definition

This document defines how Adiabatic stores external credentials (API keys, OAuth tokens) and hands them to connectors and system components. Apps are deliberately excluded — they consume the substrate and call brokered system capabilities, never raw external credentials (see Caller Contract). It is distinct from [Local Capability Auth](202606010000-Local%20Capability%20Auth.md): that decision governs *who may call core* (process-local capability tokens); this one governs *external credential custody*. The two share the word "auth" and nothing else.

## Decision

Secrets are managed by one broker. The invariant is bounded, not absolute: a raw secret **never reaches an app and never persists in clear** (it lives encrypted, behind the vault). A **trusted connector or system runtime** does receive a token through `getToken()` — connectors are the egress layer, run in an isolated runner, and pass the trust gate, so the trust gate (not a broker membrane) is the boundary for runtime. `auth.fetch()`, which keeps the token broker-side even from connectors, is future hardening. The broker owns secret storage, OAuth protocol execution, and scoped credential handles. It does not own the permission model (Guard), model routing (AI gateway), connector setup UI (supervisor/shell), or the core capability tokens (Local Capability Auth).

A secret is invisible plumbing, not a product. Connectors use credentials to make calls; the user never browses, organizes, or audits a vault as a primary task. This is why Adiabatic is not a password manager even though it stores secrets — and it is why a zero-knowledge, user-held key is affordable here: the secrets are re-issuable upstream (re-enter an API key, re-auth an OAuth source), not irreplaceable data.

## Caller Contract

`auth.type` selects a fixed protocol flow. The connector manifest declares the non-secret configuration the flow needs; the broker executes the flow; connector code only ever receives a handle.

```
auth.type:  none | apiKey | oauth2
```

```
AuthHandle =
  | { type: "none" }
  | { type: "apiKey" | "oauth2"; getToken(): Promise<string> }
```

The runtime handle is read-only and minimal: it yields a credential, it cannot manage one. `getToken()` returns the raw secret and the caller applies its own header — `apiKey` as the connector requires (`Bearer` / `Basic` / `x-api-key`), `oauth2` as `Bearer <token>`. The broker never builds the header (matching the current `getToken()`-only runtime handle). Lifecycle actions — `connect` / `disconnect` / `rotate` — are a **separate management surface** for the shell/supervisor, never on the runtime handle: revoking a user's credential is not something connector code may invoke.

`auth.type` chooses the flow; manifest metadata makes the flow runnable; the broker runs it; connector code does not participate in the flow.

### Where the auth.type boundary is

**`auth.type` is the boundary of the system-managed auth flow.** A connector manifest should not require a reader to infer who owns the OAuth app or where the client secret lives from missing fields. If the broker asks for different user input, runs a different exchange path, or delegates to hosted infrastructure, that is a real type boundary. Two rules follow:

- **Use standard OAuth fields inside direct OAuth flows.** `authorizationEndpoint`, `tokenEndpoint`, `clientId`, and `scope` keep the OAuth/OIDC meanings, spelled in the connector manifest's camelCase convention. PKCE (`code_challenge_method=S256`, RFC 7636) is always-on broker behavior, not a manifest field.
- **Name Adiabatic deployment models explicitly.** Direct public OAuth and hosted OAuth are product contracts, not OAuth metadata. They must be visible in `auth.type`, not implied by missing fields or provider-specific options.

Worked examples:

| type | why it is its own type | why its variants do *not* split |
|---|---|---|
| `none` | no-credential mechanism | — |
| `apiKey` | a static user-supplied secret | Bearer / Basic / `x-api-key` are just header formats the connector applies — zero invented config |
| `oauth2-public` | direct Authorization Code + PKCE using an author-provided public client id | no secret; connector code still receives a generic `oauth2` runtime handle |
| `oauth2-hosted` | official hosted OAuth ceremony for confidential or provider-specific OAuth | hosted service owns provider metadata, secret handling, refresh behavior, and provider quirks |
| `hmac` (future) | a key+secret that *signs* each request | not expressible as "attach a header" — earns a type when a connector needs it |

The runtime connector handle remains smaller than the manifest contract: all OAuth manifest flows yield `context.auth.type === "oauth2"` plus `getToken()`. The manifest type selects setup/exchange behavior; connector code only consumes the resulting token.

### Who receives credentials

The broker is separate from Guard. Guard is the write and provenance boundary for D0/D1/D2; Auth brokers external credentials. Auth calls never route through Guard — the runtime decides which capability handle each caller receives by caller type.

**External egress is brokered; apps never hold raw external credentials.** An app that could call `auth.getToken()` would become an unaccounted external integration runtime: UI/browser code would see provider tokens, app manifests would grow OAuth scopes and reconnect UX, and — most corrosive for Adiabatic — D0 provenance would blur (was this fact ingested by a connector or fetched app-side?). So the boundary is not only a security rule, it preserves D0 source provenance.

| Runtime | Receives |
|---|---|
| Connector | `guard.writeEvent` · `state.get/set` · `auth.getToken()` (future: `auth.fetch()` keeping the token broker-side) |
| AI gateway | `auth.getToken()` for model-provider credentials |
| Retrieval | calls the AI gateway; holds no provider keys directly |
| App / job | `system.query` · `system.writeDoc/writeEvent/write` (table-scoped) · later `system.ai.*` / `system.retrieval.*` — **no `auth.getToken()`** |

An app that needs external data models it as a connector (ingest to D0, then read the substrate) or calls a brokered system capability (AI gateway, retrieval). The raw secret never enters app (WebContainer) memory.

## Secret Storage — E2E Envelope

A random 256-bit `vault_key` is the encryption root. Secret values are encrypted under it; only the ciphertext is persisted. The `vault_key` is never written to the database.

```
store:  ciphertext = encrypt(secret_value, vault_key)
        DB.auth_secret_items(ref, ciphertext, nonce, algorithm)   # ciphertext only
use:    vault_key = keychain.get()                                # not from DB
        secret_value = decrypt(ciphertext, vault_key)
```

Two custody domains stay separate: the database/substrate holds only ciphertext, and the key lives elsewhere (device keychain plus the recovery code). A breach of one domain alone does not expose secrets; both halves are required.

- **OS keychain** caches the `vault_key` per device. It is device-dependent by design: the cached key never leaves the machine, so keychain alone does not solve multi-device — it only removes daily re-entry.
- **`vault_id` is workspace-local, stable, and non-secret.** Electron uses it to find the per-workspace keychain entry for the `vault_key`. It lives in `.adiabatic/settings.json` as system-owned workspace metadata, is generated once when the workspace vault is first initialized, and is never derived from the workspace path (so moving/renaming the folder does not change the keychain lookup identity).
- **Recovery code** is the cross-device bridge: the `vault_key` rendered as a human-typable string (reversible encoding, *not* a hash — a hash cannot be reversed back to the key). Typing it on a new device reconstructs the `vault_key` into that device's keychain. The recovery code and the root key are the same material in two representations.

A new device needs both halves: the key (via the recovery code) and the ciphertext (via the synced substrate / the user's own folder sync). The recovery code transports the key; ciphertext transport is the separate substrate-sync concern. Keeping them on different channels preserves the two-domain separation.

## Unlock — v1, and Keyslots as Future Extensibility

The `vault_key` must be obtainable on each device. **v1 has exactly one unlock:** the OS keychain caches the `vault_key` for daily use, and a user-saved **recovery code** (the `vault_key` in printable form) bootstraps a new device or recovers after keychain loss. No server, no Google, no extra config.

Additional unlock methods — passphrase, Google escrow, trusted-device transfer, iCloud Keychain — are modeled as **keyslots**: a keyslot is one more way to obtain the same `vault_key`, so adding one never re-encrypts secrets (the lock-in-relevant decision, a stable random `vault_key` with secrets enveloped under it, is already fixed). **The keyslot model's concrete schema and mechanics are future work** and deliberately not specified here; nailing them down now would over-lock a v1 that does not need them, and it cannot foreclose any future custodian because keyslots are additive by construction.

**Custody is a tradeoff, not a ranking.** When keyslots beyond v1 are built, the choice is *who the custodian is*; each option optimizes a different axis. (The constraint below is a fact, independent of the choice.)

> **Constraint (fact):** "no recovery + unlock from sign-in alone + an offline prior device" together require that *some* custodian can release the key from identity alone.

| Custodian | New-device UX | Who can decrypt | Your infra / liability | Cross-platform | Failure mode |
|---|---|---|---|---|---|
| User-held (recovery code) | type code once | only the user | none | yes | forgot code + all devices lost → re-enter secrets |
| iCloud Keychain | automatic | Apple | none | Apple-only | tied to iCloud account |
| Google Drive escrow | sign in | Google account holder | none (Google's) | yes | account lockout / Workspace policy / app verification |
| Self-hosted server | sign in | you (if you hold both halves) | you build/run/secure | yes | your uptime; you are the custodian |

Because keyslots coexist, custody need not be a single global decision — multiple can be offered and the end user picks (minimal-friction managed unlock, or zero-knowledge user-held).

**Directional note (implementation deferred):** the intended future convenience path is a `google_account` keyslot whose target UX is *sign in with Google → the root key is retrieved directly* (the Google-escrow row above). It is additive — user-held does not disappear, it becomes the fallback. The mechanism, escrow location, and verification are out of scope here.

**Forgetting the key.** By design there is no backdoor — any path that recovers without the key *is* a custodian. If the key is truly lost the encrypted secrets are unrecoverable, but the cost is bounded to re-onboarding replaceable credentials, not data loss (only credential values sit under the `vault_key`; integrations, config, and D0 do not). The recovery code is also re-viewable on any already-unlocked device, so loss requires every device gone *and* the code never saved.

## OAuth2 — Direct Public and Hosted

v1 supports one direct OAuth flow: Authorization Code with PKCE for author-owned public clients. The flow is local and has no intermediary: the broker opens the provider authorization URL, receives the redirect on a loopback callback (core `/oauth/callback`, unauthenticated, `state` as CSRF protection), and exchanges the code directly with the provider. The token never transits a third party.

The direct OAuth receiver contract is deliberately narrow. Adiabatic supports exactly these loopback callback URLs:

```text
http://localhost:32100/oauth/callback
http://localhost:32101/oauth/callback
http://localhost:32102/oauth/callback
```

The workspace core port is chosen from that set and persisted in `.adiabatic/settings.json`. Authors using `oauth2-public` must whitelist all three URLs in the provider app. Providers that cannot accept this receiver profile are not supported by direct OAuth and should use `oauth2-hosted`. The callback stays outside `/api/*`, but still enforces the localhost host restriction and live `state` validation. If the user explicitly rotates the core port later, existing OAuth tokens may continue to refresh, but exact-match providers require updating the registered redirect URI before the next reconnect/re-authorization.

`scope` is an array for YAML ergonomics and is joined to the standard space-delimited string at the broker boundary.

```yaml
auth:
  type: oauth2-public
  authorizationEndpoint: https://provider.example/oauth/authorize
  tokenEndpoint: https://provider.example/oauth/token
  clientId: author-public-client-id
  scope:
    - read
```

`oauth2-public` is for providers that support distributable public clients. The author ships the public `clientId`; the core opens the provider authorization endpoint, receives the local loopback callback, and exchanges the code directly with the provider using PKCE and no client secret.

```yaml
auth:
  type: oauth2-hosted
  connectEndpoint: https://auth.adiabatic.com/connect/oura
  scope:
    - daily
    - heartrate
```

`oauth2-hosted` is the official hosted OAuth path for confidential apps and provider-specific OAuth. The hosted auth service owns the provider client id, client secret, provider token endpoint, redirect URI, provider review/compliance, refresh token custody, refresh behavior, and the browser OAuth ceremony. The local manifest does not carry provider OAuth metadata. This contract deliberately does **not** include the R1 token-exchange relay model; there is no local authorize + loopback + remote token-only relay mode.

The local auth module still brokers runtime access. For `oauth2-hosted`, `ConnectorAuthManager` stores the hosted credential binding and may cache short-lived access tokens encrypted in `SecretStore`. The hosted service remains the durable owner of provider refresh tokens. `getToken()` returns a valid access token from the local cache when possible; when the cache is missing or expired, the auth module will call the hosted auth service to obtain a fresh access token and update the encrypted cache. The actual hosted credential/token API is deferred until the official auth service is designed. In the current local build, `oauth2-hosted` validates as a manifest type but cannot be connected yet.

Adiabatic's own "Sign in with Google" (used by the future `google_account` keyslot) is the app's own public/installed OAuth client (PKCE + loopback); it is unrelated to the connector shared-secret rule.

For direct `oauth2-public`, the OAuth2 secret blob holds the access token, refresh token, and expiry together; `auth_credentials.expires_at` duplicates the expiry in clear so the scheduler can decide to refresh without decrypting. For `oauth2-hosted`, the blob holds the hosted binding plus the encrypted short-lived access-token cache, not the provider refresh token. `getToken()` is the lazy-refresh point. Any refresh path must single-flight per credential (one in-flight refresh, other callers await its result).

### Loopback callback and the capability gate

Local Capability Auth requires every `/api/*` route to reject unauthenticated requests. The OAuth redirect lands on a callback that is necessarily unauthenticated (the provider's browser redirect carries no core token), so it is a **deliberate carve-out**: it lives at `/oauth/callback`, *outside* the `/api/*` capability gate by design. It still enforces the localhost-`Host` restriction, and the `state` parameter is not merely "CSRF protection" — it is **single-use, time-boxed, and bound to the specific pending PKCE transaction** (its `code_verifier`), so a callback that does not match a live, unexpired, unconsumed authorization attempt is rejected.

## Data Model and Control-Plane Status

```
auth_accounts        id, label, subject, created_at
auth_credentials     id, kind, account_id, owner_type, owner_id, scopes_json, status, secret_item_id, expires_at, status_changed_at, created_at, updated_at
auth_secret_items    id, ciphertext, nonce, algorithm, created_at, updated_at      # encrypted value
```

(No `provider` column: the upstream service is implied by the owning connector, and a `provider` label would be redundant with the connector id/name. Display and control-plane review group by the connector recorded in `owner`.)

(A keyslot table for unlock methods beyond v1 is future work — see Unlock; v1 stores the `vault_key` in the OS keychain with the recovery code as the bootstrap, so it needs no keyslot rows.)

The schema does not adapt per auth type; the type lives in a discriminator plus an opaque payload, so a new type adds zero columns. Three things live in three places:

- **Flow config (how to run the auth) is *not* in the DB** — it is static connector-manifest data (standard OAuth client metadata: `authorization_endpoint`, `token_endpoint`, `client_id`, `token_endpoint_auth_method`, …), identical for every user of that connector. The DB stores only the per-user *result* and binding.
- **Secret values (the type-varying sensitive part) live inside the ciphertext.** `auth_secret_items.ciphertext` is an encrypted JSON blob whose internal shape is type-specific (`api_key → {value}`, `oauth2 → {access_token, refresh_token, expires_at}`, `hmac → {key, secret}`); the DB sees only opaque ciphertext and never a per-type column. This is the classic discriminator + common-columns + opaque-payload pattern, with encryption making the varying part naturally opaque — adding a type is a new `kind` value plus a new blob shape, no migration.
- **Common, queryable, non-secret metadata are the `auth_credentials` columns:** `kind` (the auth.type discriminator), the owner/account binding, `scopes_json`, `status` (`active | expired | revoked | refresh_failed` — feeds the attention surface), `expires_at` in clear (so refresh can be scheduled and expiry shown without decrypting), and `secret_item_id`.

Storage and access:

- `auth_secret_items` is a **separate table, not a column**: the most locked-down store, holding the per-secret encryption envelope (`nonce`, `algorithm`, future `key_version` for re-key) so secrets rotate on their own lifecycle, independent of the binding row. It is the durable `SecretStore` backend's backing table (the test backend uses memory; `secret_item_id` is the key into either). `SecretStore.get(ref)` = read ciphertext here → decrypt with the keychain `vault_key` → value.
- Ciphertext lives in the `.adiabatic` SQLite database and that is safe precisely because it is E2E — the `vault_key` is never in the DB. When multi-device sync arrives, this table rides along as ciphertext; the `vault_key` (keychain / recovery code) is the only thing that does not sync.
- Ciphertext (`auth_secret_items`) and non-secret metadata (`auth_accounts`, `auth_credentials`) may sync across devices; the `vault_key` (keychain) and the recovery code (user-held) never sync through the DB. This keeps the two custody domains separate, exactly as in the envelope.
- A secret's logical scope is the **source identity** (workspace-logical), not the device. `auth_ref` travels with the integration in the substrate; the value is resolved by whatever backend the current device has.
- **Owner** is `(connector | ai-gateway | system, account)` — never an app (apps do not hold external credentials), never a device. Ownership is *recorded* at connect time (the user binds a credential to a specific integration → `auth_credentials.owner` + the integration's `auth_ref`) and *enforced* at run time by the runtime: it knows the caller because it launched it, resolves `auth_ref` host-side, and hands a pre-bound handle. The caller never holds or presents `auth_ref` — it calls `getToken()` with no argument, exactly as a connector never supplies its `source`.

### Auth tables are not app-readable

The auth tables live in the **system DB**, not the user-substrate DB, so app code cannot read ciphertext or credential metadata even though it can query `D0`/`D1`/`D2`. This is enforced structurally: the app query path opens only the data DB. That separation is a substrate-level refactor auth depends on but does not own — see [System Database Separation](202606150100-System%20Database%20Separation.md). Standing up the system DB is a prerequisite for adding any auth table.

### Process boundary: keychain in Electron, auth tables in core

**Context.** `safeStorage` (the OS keychain) is only available in the Electron main process, but `core` is a separate Bun child it launches; and core, not Electron, owns the workspace and its databases.

**Decision.** Split along the natural ownership line:

- **Electron main owns the `vault_key`** (device-specific, the keychain's domain). At boot it reads/unlocks the `vault_key` from the OS keychain and hands it to core once over the existing secure channel (the same mechanism as `ADIABATIC_CORE_TOKEN`). No per-secret IPC.
- **core owns the auth tables and the crypto** (the workspace/DB is core's domain). With the `vault_key` in hand it encrypts/decrypts locally and reads/writes the system DB. The auth broker is a **core module parallel to Guard, not part of Guard** (Guard is the D0/D1/D2 write path; auth is its own broker).

The `vault_key` residing in core memory is acceptable under the existing threat model (Local Capability Auth already excludes process-memory inspection). Standalone core with no Electron host (dev/tests) takes the `vault_key` from an env var or an ephemeral key — deliberately minimal, no elaborate encrypted-file fallback.

Auth lifecycle does **not** produce D0 events. Credential connect, rotate, revoke, refresh, and refresh failure are provisioning/control-plane state, not substrate facts or code-trust decisions. The broker updates `auth_credentials.status`, timestamps, and non-secret metadata in `system.db`; the Source Console attention surface derives from that state plus integration setup state. Do not add `auth.*` D0 event types and do not reserve an `auth.*` event namespace in Guard. Keep the `auth_` table-name prefix reserved in Guard only as data-DB schema protection.

## What to Build, and What Is Externally Blocked

There is no artificial build-effort phasing: the whole local auth module is built together. What is deferred is deferred only because it depends on something that does not exist yet, not because the code is large.

**Build now — the complete local auth module:** the `SecretStore` interface (`set`/`get`/`delete`/`has`, swappable backend) + the `vault_key` envelope + OS-keychain unlock + recovery code + the two databases (data / system) + the data model + **apiKey** (resolves the present pain: API keys evaporating on restart) + direct **OAuth2 public-client PKCE** (`oauth2-public`) + loopback callback. This is one coherent thing, built together.

**Deferred only by an external dependency** (not by build effort, and not by verification):

- **Hosted OAuth for shared-secret confidential apps** — needs the official auth service and credential handoff protocol. The manifest contract is `oauth2-hosted`, but local connect is stubbed until that service exists.
- **`google_account` / `icloud` / `trusted_device` keyslots** — need the `devices` registry / multi-device sync. Additive, zero re-encryption.

The `SecretStore` backend is swappable: an in-memory backend for tests, and a durable backend for production where Electron main supplies the `vault_key` (from the OS keychain) at boot and core encrypts to the system DB. Standalone core with no Electron host takes the `vault_key` from an env var or an ephemeral key — deliberately minimal, with no encrypted-file fallback.

## Non-Goals

- Hosted OAuth relay / shared-secret confidential clients (future hosted cloud).
- An OAuth provider registry or catalog — the broker is a generic flow executor and does not know Google, GitHub, or Oura as built-in providers.
- The permission model (Guard's responsibility).
- Being a password manager as a product.
- Defending against a user or administrator who can inspect process memory or environment variables (inherited from Local Capability Auth).
