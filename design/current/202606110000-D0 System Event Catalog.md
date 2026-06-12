# D0 System Event Catalog

Status: canon. Update this catalog whenever a system component starts emitting a new D0 event type.

D0 is the append-only event ledger. Every write goes through Guard, which stamps `source` provenance. This doc catalogs the event types the **system itself** writes — as opposed to product data written by apps and connectors. It exists so that event consumers (Activity view, retrieval, future triggers) and future agents know exactly what is in the ledger and what is not.

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

## Explicit `writeEvent` paths (not system events)

For completeness — these write D0 but are product data, not part of this catalog's namespace:

- **Connector events**: connector code calls `guard.writeEvent()`; source is injected as `connector:<id>[:<key>]`; `externalId` is required and `(source, external_id)` duplicates are idempotent no-ops. Event types are connector-defined (`app.commit`, `oura.sample`, ...).
- **App events**: apps call `system.writeEvent()` through the bridge; source is `app:<app-id>`; types are app-defined.
- **Host API writeEvent**: host-authenticated `POST /api/events` writes with source `system:server`. Used sparingly; not an auto-log.

## Invariants

- D0 is append-only; system events are never updated or deleted.
- Every event has `source` stamped by Guard from runtime identity — callers never supply it.
- The `d1.*` / `d2.*` / `ddl.*` / `connector.*` (lifecycle) type namespaces are system-reserved. Guard enforces this at write time: an explicit `writeEvent` with a reserved-namespace type requires a `system:*` source, so apps and connectors cannot forge lifecycle or CDC records.
- Locked docs (`metadata.locked`) are the single sanctioned gap in the audit trail.
