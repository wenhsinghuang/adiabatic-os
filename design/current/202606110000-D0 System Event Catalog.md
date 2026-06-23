# D0 System Event Catalog

Status: canon. Update this catalog whenever a system component starts emitting a new D0 event type.

D0 is the append-only event ledger. Every write goes through Guard, which stamps `source` provenance. This doc catalogs the event types the **system itself** writes — as opposed to product data written by apps and connectors. It exists so that event consumers (Activity view, retrieval, future triggers) and future agents know exactly what is in the ledger and what is not.

## Recording Boundary — what is D0 material, and what is not

D0 is the substrate's permanent history, not an operations log. Keeping a hard floor here is what stops D0 from degrading into UI/ops telemetry. An event is D0 material only if it is one of exactly three kinds:

1. **Substrate fact** — something Adiabatic should remember long-term and that future derivation can use: a connector observation (commit, calendar event, terminal line), a D1 doc edit, a D2 row change.
2. **User-owned executable artifact changed** — an inspectable, diffable, revertable system-capability artifact changed: a connector package installed/removed, an app created/archived, app code committed. *Not* runtime config or status.
3. **Human trust decision on executable code** — the user authorized a specific piece of code/hash to become an executable capability: connector package approved. This is not an ordinary permission; it is "this code may enter my system."

Everything else stays in **control-plane current state** (`system.db`), never D0. Two anti-slip tests catch the rest:

- *Would this still matter if the connector/app stopped running tomorrow?* `connector.approved` would (you once trusted that code); `app.commit` would (the capability itself changed); `auth.refresh_failed` would not (it was just the runtime state at the time).
- *Is this primarily for UI status, debugging, retry, setup, or health display?* If yes, it is not D0. This excludes **auth** (connect/refresh/revoke/fail), **requirements/provisioning**, **scheduler/run status**, connector `warnings`, `last_error`, `next_run`, `enabled/disabled`, and integration config.

So **auth credential lifecycle does not produce D0 events.** Auth is provisioning that lets a connector run (the setup evaluator already treats it as a *requirement*, alongside OS permissions) — not a substrate fact, not an executable artifact, not a code-trust decision. Credential metadata and status live in `system.db` as control-plane state.

This is deliberately reversible: a new event type is additive and non-breaking, so the default is to *exclude*. If a concrete need later appears (e.g. a privacy audit of "when did I grant which external scope"), add the event then — or keep it as `system.db` credential metadata (`granted_at`). `system.db` holds control-plane current state (some of it durable, like credential metadata and integration config); it is **not** a second event log.

## Source conventions

```text
system:server          core host Guard (auto-logs, host API writeEvent)
system:test            test-only Guard instances
app:<app-id>           app writes through the bridge
connector:<id>         singleton connector integration
connector:<id>:<key>   multiple connector integration
```

System events are identified by source prefix `system:`. The `type` namespace below is reserved for Guard/system use; apps and connectors must not emit these types.

## Auto-logged Guard events

These are written automatically by Guard as a side effect of the corresponding write path. They are the CDC/audit trail; callers cannot opt in or out (one exception below).

### `d1.write` — doc upsert

Emitted by `Guard.writeDoc()` on every D1 doc create/update.

```text
payload:
  doc_id   string
  patch    unified diff (git-style) from previous content to new content
  bytes    byte length of the new content
```

Stores a patch, not full before/after content, to keep the ledger compact. Creation uses `/dev/null` as the old path.

**Exception:** docs with `metadata.locked === true` skip the auto-log. This is the only Guard write that can bypass D0.

### `d1.delete` — doc delete

Emitted by `Guard.deleteDoc()`.

```text
payload:
  doc_id    string
  content   full content snapshot at deletion time
  metadata  doc metadata or null
```

Full snapshot, not a patch — this is the safety net for hard deletes.

### `d2.insert` / `d2.update` / `d2.delete` — table CDC

Emitted by `Guard.write()` for every DML statement against a D2 table (app writes through the bridge, host writes through the API).

```text
payload:
  op             insert | update | delete
  table          target table name
  primary_key    array of PK objects for affected rows, or null
  before         row snapshots before (null for insert)
  after          row snapshots after (null for delete)
  affected_rows  count
  sql            the statement, truncated to 500 chars
  params         bound parameters
```

Captured via temporary triggers inside the write transaction, so the CDC rows are exact, not re-derived.

### `ddl.promote` / `ddl.demote` — schema change

Emitted by the privileged schema lifecycle API (`adiabatic promote` / `demote`, schema request approval).

```text
payload:
  ddl             array of executed DDL statements
  before_schema   full schema snapshot before
  after_schema    full schema snapshot after
  requested_by    requester identity or null
  schema_version  D0 schema version
```

### `connector.installed` — package installation

Emitted by the explicit install flow (`installConnectorFromSource()`, today serving the bundled built-in catalog; the future download flow uses the same path).

```text
payload:
  connector_id   string
  package_hash   sha256:<hex> of the installed package content
```

Every event corresponds to one explicit install action — nothing installs implicitly. A reinstall after removal emits a fresh event, so D0 carries the full install/remove history of every package.

### `connector.approved` — trust decision

Emitted by `ConnectorSupervisor.approveCurrentPackage()` (the human approve flow).

```text
payload:
  connector_id   string
  approved_hash  sha256:<hex> of the approved package content
```

The audit core of the package trust model: who trusted which exact content, when. Re-approval after a package change emits a new event.

### `connector.removed` — package removal

Emitted by `ConnectorSupervisor.unregister()` when a connector package is removed from the workspace.

```text
payload:
  connector_id   string
```

Integration rows survive removal as non-runnable (trust flips to missing); this event records the package-level action.

### `app.created` — app registered

Emitted by the create-app flow (`POST /api/apps`) after the app folder is scaffolded and the registry reloads.

```text
payload:
  appId   string
```

Only the id is recorded: at creation the name mirrors the id and the write scope is always empty, so both would be redundant/constant. The name and scope evolve later through `app.commit` (manifest edits are code commits) — `app.created` is the composition act, `app.commit` is the content history.

### `app.archived` — app retired

Emitted by the archive flow (`POST /api/apps/:id/archive`). Archiving moves the app's folder — git history and all — out of `apps/` into `.adiabatic/archived-apps/<appId>`, so it leaves the active registry and the app-commits watcher but stays recoverable by moving the folder back. There is deliberately **no hard-delete path**: removal is archival.

```text
payload:
  appId   string
```

Only the id is recorded: the archive location is conventional (`.adiabatic/archived-apps/<appId>`) and the name lives in the preserved manifest. The capability was retired, not destroyed — D0 keeps the full create → commit → archive history regardless of the folder's later fate.

## Explicit `writeEvent` paths (not system events)

For completeness — these write D0 but are product data, not part of this catalog's namespace:

- **Connector events**: connector code calls `guard.writeEvent()`; source is injected as `connector:<id>[:<key>]`; `externalId` is required and `(source, external_id)` duplicates are idempotent no-ops. Event types are connector-defined (`app.commit`, `oura.sample`, ...).
- **App events**: apps call `system.writeEvent()` through the bridge; source is `app:<app-id>`; types are app-defined.
- **Host API writeEvent**: host-authenticated `POST /api/events` writes with source `system:server`. Used sparingly; not an auto-log.

## Invariants

- D0 is append-only; system events are never updated or deleted.
- Every event has `source` stamped by Guard from runtime identity — callers never supply it.
- The `d1.*` / `d2.*` / `ddl.*` / `connector.*` (lifecycle) namespaces, plus the `app.created` / `app.archived` lifecycle types, are system-reserved. (`app.commit` is connector product data and stays open.) Guard enforces this at write time: an explicit `writeEvent` with a reserved type requires a `system:*` source, so apps and connectors cannot forge lifecycle or CDC records.
- Locked docs (`metadata.locked`) are the single sanctioned gap in the audit trail.
