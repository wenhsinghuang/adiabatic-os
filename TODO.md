# Adiabatic OS TODO

Live backlog. Keep this high-level; expand only when a direction is actively being implemented.

## Roadmap

### Cold start prereqs

- [ ] System DB separation: substrate vs control-plane
  - Design: [System Database Separation](design/current/202606150100-System%20Database%20Separation.md).
  - Split the one SQLite file into a data DB (D0/D1/D2, app-queryable via Guard) and a system DB (connector + auth control-plane, never app-readable); app query/write paths open only the data DB.
  - Closes the pre-existing exposure of `connector_integrations` etc. via `/api/query`, and is a prerequisite for adding any auth table.
  - Substrate-level refactor, not auth-specific; auth is one consumer.

- [ ] Auth / secrets module
  - Unified management for API keys, OAuth, and scoped runtime credentials.
  - Design: [Auth and Secret Store](design/current/202606150000-Auth%20and%20Secret%20Store.md).
  - Broker holds raw secrets; callers get capability handles. E2E envelope: random vault_key, ciphertext-only in DB, recovery-code unlock with keyslots as future extensibility.
  - Build the whole local module together (no build-effort phasing): SecretStore + vault_key envelope + OS-keychain unlock + recovery code + apiKey + OAuth2 PKCE engine + loopback callback. Depends on the system DB separation above.
  - Deferred only by external dependency: shared-secret confidential OAuth (needs hosted relay); google_account / multi-device keyslots (need the devices registry).

- [ ] Built first few important connectors

- [ ] Cold-start my personal system
  - Cold start is apps/data built on the substrate, not substrate itself.
  - Require connectors and internal event hook subscription completed.

### MVP

- [ ] D0 event subscription / hooks
  - Guard API: `subscribe({ type }, fn)` or equivalent event stream
  - Event-trigger source for the trigger runtime
  - Shared substrate for app subscribe and connector subscribe
  - All automation/event flow should continue to pass through D0

- [ ] Trigger runtime
  - Trigger/Cron table
  - Two minimal app convention entry points (1 normal, 1 job run)
  - CLI
  - Dispatcher in host shell
  - Dispatcher reads trigger table, watches D0, and cold-starts apps

- [ ] AI gateway module
  - Unified interface for LLM and embedding calls used by apps, connectors, retrieval, and system jobs.
  - Provider/model routing, request/response envelope, usage metadata, and auth via the secrets module.
  - Not the AI-agent command surface; this is for model calls only.

- [ ] CLI / AI agent system interface
  - Interface for AI agents to use Adiabatic system capabilities: query D0/D1/D2, write docs/events, request schema changes, and run approved system actions.
  - Guard CLI / system CLI should expose capability-scoped operations, not raw DB mutation.
  - Should be usable by coding agents and local automation without depending on the AI gateway.

- [ ] WebContainer Guard module
  - WebContainer should preload/install the Guard/system module.

- [ ] Retrieval / memory module
  - Replaceable retrieval data source over D0/D1/D2.
  - See [Retrieval Memory Module Requirements](design/current/202606040000-Retrieval%20Memory%20Module%20Requirements.md).

- [ ] Connector production
  - Status: v0.1 local substrate exists — manifest/framework, `connectors/<id>/` install/remove, explicit bundled catalog install, Source Console/Catalog UI, hash trust gate, runner isolation, scheduler, and `app-commits` package.
  - End-to-end verify `app-commits`: install from catalog -> approve package -> scheduler run -> D0 `app.commit` events.
  - built-in: Terminal connector, after capture/privacy policy is explicit.
  - Official trust catalog: generate hashes from `template/connectors/`, publish signed/R2 catalog, load/cache at runtime, and auto-classify matching packages as `official`.
  - Update/reinstall flow: detect newer bundled/official package hashes, preserve runtime state, never overwrite edited packages silently.
  - Auth/secrets: replace temporary API-key token path with unified secret store and OAuth browser flow.
  - Push / webhook runtime mode: a 4th mode beyond watch/poll/import where the provider pushes events to a public receive endpoint (see Hosted relay / edge). Only needed for inbound-webhook-only services (e.g. Stripe). Outbound realtime — long polling, WebSocket, Socket Mode (Telegram getUpdates, Slack Socket Mode) — is already covered by `watch` and needs no endpoint; webhook-capable services fall back to watch/poll until the relay exists.
  - Remote connector catalog/download source; current catalog only lists bundled packages.
  - Purge/forget connector action for destructive cleanup of integration config, checkpoint, auth refs, and schedules.

### Production

- [ ] CI/CD and R2 artifact push
  - GitHub Actions compiles `template/connectors/` packages into the official connector catalog.
  - Publish official connector catalog/package hashes to R2 for runtime official trust lookup.
  - Placeholder official catalog URL until CI publishes the real R2 artifact:
    `https://r2-placeholder.adiabatic-os.invalid/connectors/official-catalog.json`
  - Replace placeholder URL and wire core startup catalog loading after CI/R2 publishing is live.

- [ ] Shell redesign

- [ ] landing page + discord 

### backlog

- [ ] Blob / artifact store
  - Store binary files like images, PDFs, and attachments with DB references.

- [ ] Hosted relay / edge (local-first's public touchpoint)
  - One optional cloud component serving the needs local-first cannot meet on localhost alone:
    - Webhook receive endpoint -> routes provider pushes to the local connector runtime (enables the push/webhook runtime mode)
    - OAuth token-exchange relay for shared-secret confidential clients (see [Auth and Secret Store](design/current/202606150000-Auth%20and%20Secret%20Store.md))
    - Possibly later: multi-device sync transport / key escrow
  - Until it exists: connectors poll instead of receiving webhooks, and OAuth stays PKCE-public or user-supplied-confidential only.
  - Must stay optional and not become a required custody/trust anchor — the local substrate works without it.

- [ ] Multi-device runtime target routing (late; built on the multi-device sync `devices` registry)
  - `devices` table is multi-device sync infrastructure (identity, presence, platform, status); connector integrations only reference it
  - Add `connector_integrations.runtime_device_id -> devices.id` (reserved schema in connector runtime doc)
  - One integration = one source identity assigned to one device; official cloud is a special device row
  - Requirements selected from `manifest.platforms[device.platform]`
  - Scheduler runs only integrations assigned to the current device
  - Until then: runtime target is the implicit current host; do not add the table/column early


