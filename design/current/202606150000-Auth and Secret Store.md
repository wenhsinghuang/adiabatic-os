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

**`auth.type` is the boundary of the *mechanism*, not of its parameters.** A variant becomes its own type only when it cannot be expressed as standard configuration without inventing our own term or flow. Two rules follow:

- **Lean on the domain standard; do not invent vocabulary.** The OAuth2 manifest config is a subset of standard OAuth/OIDC client metadata — the standard fields `authorization_endpoint`, `token_endpoint`, `scope`, `client_id`, `token_endpoint_auth_method` — spelled in the connector manifest's camelCase convention (`authorizationEndpoint`, `tokenEndpoint`, `scope`, `clientId`, `tokenEndpointAuthMethod`). The broker is a generic executor that consumes standard OAuth client metadata, not a bespoke schema. PKCE (`code_challenge_method=S256`, RFC 7636) is always-on broker behavior, not a manifest field.
- **Let the standard's own boundaries be ours.** If a variation maps to standard config, it stays one type; if the standard itself defines a separate flow (a different OAuth grant), or the mechanism cannot be expressed in standard config at all, that is a real type boundary.

Worked examples:

| type | why it is its own type | why its variants do *not* split |
|---|---|---|
| `none` | no-credential mechanism | — |
| `apiKey` | a static user-supplied secret | Bearer / Basic / `x-api-key` are just header formats the connector applies — zero invented config |
| `oauth2` | the standard Authorization Code grant | PKCE-public / user-confidential / relay differ only in standard client metadata (`token_endpoint`, `token_endpoint_auth_method`) — the engine runs one config-driven flow, blind to which variant (see OAuth2 section) |
| `hmac` (future) | a key+secret that *signs* each request | not expressible as "attach a header" — earns a type when a connector needs it |

The criterion reproduces exactly `none / apiKey / oauth2` (and `hmac` later), no more: the engine stays one generic executor per mechanism, and we add a type only when forced to invent.

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

## OAuth2 — Authorization Code + PKCE

v1 supports only the Authorization Code flow with PKCE (public client). The flow is local and has no intermediary: the broker opens the provider authorization URL, receives the redirect on a loopback callback (core `/oauth/callback`, unauthenticated, `state` as CSRF protection), and exchanges the code directly with the provider. The token never transits a third party.

The manifest OAuth config is the standard OAuth/OIDC fields — `authorizationEndpoint`, `tokenEndpoint`, `clientId`, `scope`, `tokenEndpointAuthMethod` — spelled in the manifest's camelCase convention. `clientId` (the OAuth app's public, non-secret client identifier) is **required** even for a public client, and lives in the manifest like every other config field. PKCE (`code_challenge_method=S256`) is always-on broker behavior, not a manifest field. `scope` is given as an array for YAML ergonomics and joined to the standard space-delimited string at the broker boundary. `tokenEndpointAuthMethod` defaults to `none` (public client). The broker is one config-driven Authorization Code executor: it assembles the request from this config and is blind to which "variant" results. PKCE-public, user-confidential (a user-supplied `client_secret`, `tokenEndpointAuthMethod: client_secret_*`), and relay are points in that config space, not engine branches:

| variant | `token_endpoint` | accompanies the code | `token_endpoint_auth_method` |
|---|---|---|---|
| PKCE-public | provider | `code_verifier` | `none` |
| user-confidential | provider | `client_secret` (+ optional verifier) | `client_secret_basic` / `client_secret_post` |
| relay (future) | the relay | a header core already holds | (relay attaches the secret) |

The only genuinely external differences are infra (the relay must exist and be operated) and trust/blast-radius (who holds the secret) — both enforced by policy and deployment, never by the engine. The relay is designed to keep the loopback redirect and relay only the token exchange, so it stays a config point rather than a different flow.

- **`clientId` always lives in the connector manifest** — for official and custom connectors alike, exactly like the endpoints and scope. An official connector is just a package whose hash the catalog vouches for; the catalog carries only `id`/`hash`/`version` for trust and is **not a config source**, so there is no catalog fallback for `clientId`. (For an official OAuth connector, the org registers the OAuth app and writes its public `clientId` into the published manifest.) Custom connectors are additionally gated by the human approve flow.
- **A shared `client_secret` is never bundled into a connector.** A connector manifest may declare that a confidential client is needed, but never carries the secret value.
- **Confidential clients** split by where the secret comes from. A *user-supplied* `client_secret` is per-user and is a low-cost future extension (one more stored secret + one token-exchange parameter). A *shared* `client_secret` cannot be distributed to user machines honestly and requires a hosted token-exchange relay — a separate future hosted-cloud line, not a connector concern.

Adiabatic's own "Sign in with Google" (used by the future `google_account` keyslot) is the app's own public/installed OAuth client (PKCE + loopback); it is unrelated to the connector shared-secret rule.

The OAuth2 secret blob holds the access token, the refresh token, and the expiry together; `auth_credentials.expires_at` duplicates the expiry in clear so the scheduler can decide to refresh without decrypting. `getToken()` is the lazy-refresh point. Refresh-token rotation makes a refresh non-idempotent, so two concurrent `getToken()` calls near expiry could each spend the refresh token and invalidate the other — the broker **must single-flight refresh per credential** (one in-flight refresh, other callers await its result).

### Loopback callback and the capability gate

Local Capability Auth requires every `/api/*` route to reject unauthenticated requests. The OAuth redirect lands on a callback that is necessarily unauthenticated (the provider's browser redirect carries no core token), so it is a **deliberate carve-out**: it lives at `/oauth/callback`, *outside* the `/api/*` capability gate by design. It still enforces the localhost-`Host` restriction, and the `state` parameter is not merely "CSRF protection" — it is **single-use, time-boxed, and bound to the specific pending PKCE transaction** (its `code_verifier`), so a callback that does not match a live, unexpired, unconsumed authorization attempt is rejected.

## Data Model and Audit

```
auth_accounts        id, label, subject, created_at
auth_credentials     id, kind, account_id, owner_type, owner_id, scopes_json, status, secret_item_id, expires_at, created_at, updated_at
auth_secret_items    id, ciphertext, nonce, algorithm, created_at, updated_at      # encrypted value
```

(No `provider` column: the upstream service is implied by the owning connector, and a `provider` label would be redundant with the connector id/name. Display uses the connector name; audit groups by the connector in `owner` / event `source`.)

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

D0 records credential lifecycle only, never values:

```
auth.credential.created   { owner, credential_id, scopes }
auth.credential.rotated   { owner, credential_id }
auth.credential.revoked   { owner, credential_id }
auth.oauth.connected      { owner, credential_id, scopes, expires_at }
auth.oauth.refresh_failed { owner, credential_id }
```

`auth.oauth.refresh_failed` feeds the Source Console attention surface: a credential whose refresh fails surfaces for the user exactly like a crashed watch connector.

## What to Build, and What Is Externally Blocked

There is no artificial build-effort phasing: the whole local auth module is built together. What is deferred is deferred only because it depends on something that does not exist yet, not because the code is large.

**Build now — the complete local auth module:** the `SecretStore` interface (`set`/`get`/`delete`/`has`, swappable backend) + the `vault_key` envelope + OS-keychain unlock + recovery code + the two databases (data / system) + the data model + **apiKey** (resolves the present pain: API keys evaporating on restart) + the **OAuth2 PKCE engine** + loopback callback. This is one coherent thing, built together.

**Deferred only by an external dependency** (not by build effort, and not by verification):

- **Shared-secret confidential OAuth** — needs the hosted relay (infra that does not exist yet; the "Hosted relay / edge" line in the roadmap).
- **`google_account` / `icloud` / `trusted_device` keyslots** — need the `devices` registry / multi-device sync. Additive, zero re-encryption.

The `SecretStore` backend is swappable: an in-memory backend for tests, and a durable backend for production where Electron main supplies the `vault_key` (from the OS keychain) at boot and core encrypts to the system DB. Standalone core with no Electron host takes the `vault_key` from an env var or an ephemeral key — deliberately minimal, with no encrypted-file fallback.

## Non-Goals

- Hosted OAuth relay / shared-secret confidential clients (future hosted cloud).
- An OAuth provider registry or catalog — the broker is a generic flow executor and does not know Google, GitHub, or Oura as built-in providers.
- The permission model (Guard's responsibility).
- Being a password manager as a product.
- Defending against a user or administrator who can inspect process memory or environment variables (inherited from Local Capability Auth).
