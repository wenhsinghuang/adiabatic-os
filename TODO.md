# Adiabatic OS TODO

Live backlog. Keep this high-level; expand only when a direction is actively being implemented.

## Roadmap

- [ ] Cold-start my personal system
  - Cold start is apps/data built on the substrate, not substrate itself.
  - Require connectors and internal event hook subscription completed.

- [ ] Connector production
  - Connector interface + convention + framework
  - Install/remove as `connectors/<id>/` workspace folders
  - Materialize built-ins into `connectors/<id>/`, no runtime special case
  - Platform requirement lifecycle: handler contract, setup API (separate from auth connect), status persistence + API exposure, unified setup evaluator gating ready/run/scheduler
    - Trust before handler: requirement handlers are connector code; official/custom trust must pass before any setup-inspection import or check/request call — never import untrusted code to check permissions
  - Make `integrations.mode` required in manifest parsing (remove the `singleton` default; update built-in manifests + tests)
  - built-in: Terminal connector
  - built-in: App commits connector

- [ ] Multi-device runtime target routing (late; built on the multi-device sync `devices` registry)
  - `devices` table is multi-device sync infrastructure (identity, presence, platform, status); connector integrations only reference it
  - Add `connector_integrations.runtime_device_id -> devices.id` (reserved schema in connector runtime doc)
  - One integration = one source identity assigned to one device; official cloud is a special device row
  - Requirements selected from `manifest.platforms[device.platform]`
  - Scheduler runs only integrations assigned to the current device
  - Until then: runtime target is the implicit current host; do not add the table/column early

- [ ] Guard CLI

- [ ] Retrieval / memory module
  - Replaceable retrieval data source over D0/D1/D2.
  - See [Retrieval Memory Module Requirements](design/current/202606040000-Retrieval%20Memory%20Module%20Requirements.md).

- [ ] Blob / artifact store
  - Store binary files like images, PDFs, and attachments with DB references.

- [ ] Auth / secrets module
  - Unified management for API keys, OAuth, and scoped runtime credentials.

- [ ] AI gateway module
  - Central model-call wrapper for app, connector, and retrieval use.

- [ ] WebContainer Guard module
  - WebContainer should preload/install the Guard/system module.

- [ ] Trigger runtime
  - Trigger/Cron table
  - Two minimal app convention entry points (1 normal, 1 job run)
  - CLI
  - Dispatcher in host shell
  - Dispatcher reads trigger table, watches D0, and cold-starts apps

- [ ] D0 event subscription / hooks
  - Guard API: `subscribe({ type }, fn)` or equivalent event stream
  - Event-trigger source for the trigger runtime
  - Shared substrate for app subscribe and connector subscribe
  - All automation/event flow should continue to pass through D0

- [ ] Shell redesign

- [ ] CI/CD and R2 artifact push
  - GitHub Actions compiles `template/connectors/` packages into the official connector catalog.
  - Publish official connector catalog/package hashes to R2 for runtime official trust lookup.
  - Placeholder official catalog URL until CI publishes the real R2 artifact:
    `https://r2-placeholder.adiabatic-os.invalid/connectors/official-catalog.json`
  - Replace placeholder URL and wire core startup catalog loading after CI/R2 publishing is live.

- [ ] landing page + discord 
