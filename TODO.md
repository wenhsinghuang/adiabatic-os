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
  - built-in: Terminal connector
  - built-in: App commits connector

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

- [ ] landing page + discord 
