# D0 Source Boundary: Guard and Connectors

Status: current design decision

This document defines the boundary between D0 append mechanics and source-specific capture logic. It exists because terminal capture made the boundary easy to blur.

## Decision

D0 append has one write boundary:

```text
Guard.writeEvent(...)
```

Anything that becomes a D0 event must eventually pass through Guard. Guard owns how events are written.

Source-specific capture should live outside Guard, in connectors or source adapters. Connectors own why, when, and what events are emitted.

```text
Connector / source adapter
  -> capture, batch, redact, dedup, normalize
  -> Guard.withSource("connector:<id>").writeEvent(...)
  -> events
```

## Responsibilities

Guard is responsible for substrate invariants:

- source injection and non-forgeable provenance
- append-only event writes
- event schema validation
- system table protection
- D1/D2/DDL mutation audit
- SQLite transaction boundaries

Connectors are responsible for source semantics:

- what the source means
- what should or should not be captured
- batching policy
- redaction policy
- deduplication and `external_id`
- source-specific payload shape
- enable/disable policy

Guard should not grow source-specific capture behavior. Connectors should not bypass Guard.

## Terminal Decision

Terminal UI is a shell-owned local interaction surface.

Terminal transcript capture is not a shell/core logging concern. When it exists, it should be the first built-in connector:

```text
connector:terminal
```

The terminal path should eventually look like:

```text
Terminal UI / runtime
  -> Terminal connector
  -> Guard.withSource("connector:terminal").writeEvent(...)
  -> D0
```

For v0.1, terminal capture is deferred because the connector API is not designed yet. The shell may provide a terminal, but it should not emit official terminal D0 events through an ad hoc `TerminalLogger`.

Specifically:

- do not log `terminal.open`
- do not log `terminal.close`
- do not log terminal input/output until connector capture policy exists
- do not use `system:terminal` for user-world terminal transcript capture

`system:*` should be reserved for substrate/core internal events. Terminal interaction is user-world capture, not a core substrate operation.

## Guard Audit Exception

Some D0 events are produced directly by Guard because they are mutation audit, not external capture:

```text
d1.write
d1.delete
d2.insert
d2.update
d2.delete
ddl.promote
ddl.demote
```

These events describe changes Guard itself performed or authorized. They are not connector events and do not need a connector layer.

This keeps the model clean:

- external/world observation goes through connectors
- substrate mutation audit is produced by Guard
- both still enter D0 through the same append boundary

## Source Namespace

The source namespace should communicate provenance class:

```text
app:<id>              app runtime writes
connector:<id>        external or local capture sources
working-tree:pages    file-to-DB page sync
system:<component>    core substrate internals
```

Callers do not provide source. Runtime, connector host, or Guard injects source.

## Non-Goals

This document does not define the connector API.

It deliberately avoids deciding:

- connector manifest shape
- connector lifecycle
- connector permissions
- terminal redaction rules
- terminal command reconstruction
- browser AX capture schema
- background scheduling model

Those belong in a later connector design. The current decision is only the boundary: source capture belongs to connectors; D0 append belongs to Guard.

## Principle

Guard owns how events are written.

Connectors own why, when, and what events are emitted.
