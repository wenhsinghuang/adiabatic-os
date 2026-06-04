# Connector Runtime Module

Status: current module definition

This document defines the connector contract for Adiabatic OS. It follows the D0 source boundary decision: Guard owns D0 append mechanics, and connectors own source-specific capture semantics.

## Decision

A connector is a plugin runtime that turns one external or local source into D0 events.

The connector contract should not describe what kind of source the connector is. It should describe how the system can run it, authorize it, resume it, and receive D0 events from it.

```text
ConnectorHost / supervisor
  -> reads connector manifest
  -> checks platform and auth
  -> launches an isolated connector runtime
  -> passes bound system capabilities
  -> receives guard.writeEvent(...) calls
  -> injects source as connector:<instance-id>
  -> Guard.writeEvent(...)
  -> events
```

Connector code never receives a writable DB handle, never provides `source`, and never calls `withSource()`.

## Mental Model

```text
System / core
  Guard                write boundary
  ConnectorHost        supervisor, launcher, capability issuer
  Trigger runtime      decides when poll/import runs happen
  Shell                integration UI and auth UX
  Secret store         credentials
  Integration state    config, status, checkpoint

Plugin world
  Connector manifest   static declaration
  Connector runtime    isolated run unit
  Connector code       source capture/fetch/redact/normalize
```

Host is system. Connector is plugin. Built-in connectors are still plugins; they are just shipped with the system.

## Connector Manifest

The manifest is the static plugin declaration. It is file-based so it is easy to inspect, review, version, and modify.

```yaml
id: app-commits
name: App Commits
entry: ./index.ts
runtime:
  mode: watch
platforms:
  - darwin
  - linux
  - windows
auth:
  type: none
events:
  - app.commit
```

Poll connector example:

```yaml
id: calendar
name: Calendar
entry: ./index.ts
runtime:
  mode: poll
  schedule: every 15m
platforms:
  - darwin
  - linux
  - windows
  - ios
  - android
  - cloud
auth:
  type: oauth2
  provider: google
  scopes:
    - https://www.googleapis.com/auth/calendar.readonly
events:
  - calendar.event
```

The manifest declares what the system needs to know:

- `id` and `name`
- `entry`
- runtime mode and schedule
- platform compatibility
- required capabilities
- auth type
- default config schema, later
- event types emitted, for documentation and UI

It should not contain secrets or mutable sync checkpoints.

## Runtime Modes

Mode is host/scheduler metadata. Connector code still has one entrypoint.

```text
watch   long-running runtime; exits when signal is aborted
poll    scheduled one-pass run; returns after syncing current changes
import  manual one-pass run over bounded input
```

Examples:

- `watch`: terminal, app commits watcher, macOS accessibility capture.
- `poll`: calendar, Oura, GitHub API.
- `import`: Obsidian vault, Notion export, CSV/archive import.

Do not add `stream` as a separate mode yet. High-throughput streams are watch connectors with batching and backpressure policy.

## Connector Code Contract

Connector code should expose one run entrypoint.

```ts
export default defineConnector({
  async run({ guard, auth, state, config, signal }) {
    // Capture, fetch, redact, normalize.
    await guard.writeEvent({
      type: "source.event",
      externalId: "upstream-id",
      startedAt: Date.now(),
      payload: {},
    });

    await state.set({ cursor: "next" });
  },
});
```

The public context is intentionally small:

```ts
type ConnectorRunContext<TConfig, TState> = {
  guard: BoundConnectorGuard;
  auth: ConnectorAuthHandle;
  state: ConnectorStateHandle<TState>;
  config: TConfig;
  signal: AbortSignal;
};
```

The connector author should only need to understand:

- `guard.writeEvent(...)`
- `auth` as a capability handle
- `state` as private checkpoint storage
- `config` as user/system configuration
- `signal` for cancellation

They should not need to understand host internals, `withSource()`, app identity, DB handles, scheduler internals, or shell auth UX.

## Bound Guard

The connector-facing guard is a bound capability, not the raw core `Guard`.

```ts
type BoundConnectorGuard = {
  writeEvent(event: ConnectorEventInput): Promise<{ id: string }>;
  writeEvents?(events: ConnectorEventInput[]): Promise<{ ids: string[] }>;
};
```

`ConnectorEventInput` mirrors `Guard.writeEvent`, minus `source`.

```ts
type ConnectorEventInput = {
  type: string;
  externalId?: string;
  startedAt: number;
  endedAt?: number;
  payload: JsonValue;
};
```

`JsonValue` means JSON-serializable data: `null`, string, finite number, boolean, arrays, and plain objects. The payload does not have to be an object. Runtime validation rejects `undefined`, functions, `BigInt`, circular references, and non-plain objects.

The runtime injects source as `connector:<instance-id>`.

First version can use connector id as instance id:

```text
connector:app-commits
connector:terminal
```

Multi-account connectors should later use instance ids:

```text
connector:google-calendar-personal
connector:google-calendar-work
```

This matters because D0 dedup is keyed by `(source, external_id)`.

## Auth

Auth is system-managed. Connectors declare auth requirements; host and shell implement the flow.

Manifest examples:

```yaml
auth:
  type: none
```

```yaml
auth:
  type: apiKey
  label: Oura Personal Access Token
```

```yaml
auth:
  type: oauth2
  provider: google
  scopes:
    - https://www.googleapis.com/auth/calendar.readonly
```

Connector code receives an auth capability handle, not raw credential state.

```ts
type ConnectorAuthHandle =
  | { type: "none" }
  | {
      type: "apiKey" | "oauth2";
      getToken(): Promise<string>;
    };
```

Prefer capability methods like `auth.getToken()` over injecting `credentials.accessToken`.

Why:

- token refresh can happen lazily
- host controls token lifetime
- connector does not know secret-store details
- revocation and audit stay centralized
- future capability-scoped tokens remain possible

Future extension:

```ts
auth.fetch(url, init?)
```

That would let the host refresh, attach credentials, audit, and redact without exposing token strings to connector code.

## State

State is private connector runtime checkpoint data.

```ts
type ConnectorStateHandle<TState> = {
  get(): Promise<TState | undefined>;
  set(state: TState): Promise<void>;
};
```

Examples:

- `app-commits`: last seen commit SHA.
- `calendar`: sync token.
- `oura`: last synced day.
- `terminal`: current session checkpoint or last flushed chunk pointer.
- `import`: last imported file hash or offset.

State is not product data, not D0, and not secret storage. It is runtime bookkeeping so the connector can resume.

Persisted state belongs in a system-owned integration table, not in connector YAML.

## Platform And Capability Gating

Platform compatibility belongs in the manifest.

```yaml
platforms:
  - darwin
  - linux
  - windows
  - ios
  - android
  - cloud
```

Platform-specific local connectors can declare narrower support:

```yaml
id: macos-ax
runtime:
  mode: watch
platforms:
  - darwin
capabilities:
  - macos.accessibility
auth:
  type: localPermission
```

The host decides whether a connector can be enabled or run on the current platform. A macOS-only connector should simply not run on mobile. Mobile can have separate connector runtimes and platform-specific connectors.

## Integration State

Connector definition and connector instance state are separate.

```text
connector.yaml
  static plugin declaration

connector_integrations table
  enabled/status/config/sync_state/auth_ref/last_error/last_run_at

secret store
  tokens and API keys

D0 events
  connector output
```

The table is system state, not plugin code. It supports shell UI, status inspection, retries, scheduling, and reconnect/disconnect UX.

## Import Versus App

Use a connector when the task is source ingestion:

```text
external/source records -> raw D0 events
```

Use an app or job when the task is product workflow or transformation:

```text
D0/D1/D2 data -> derived tables, docs, UI, user workflow
```

An Obsidian vault import can be a connector if it preserves external notes as D0 import events. A one-off organizer that rewrites docs or creates D2 tables is an app/job.

## High Throughput

The first connector can use single `writeEvent` calls. High-throughput connectors need runtime support:

- queue
- flush interval
- max batch size
- backpressure policy
- overflow policy
- coalescing and sampling
- connector-specific redaction before enqueue

The public surface should grow by capability, not by mode:

```ts
await guard.writeEvents(events);
```

Terminal output, browser activity, and accessibility streams should not emit one D0 event per byte or tiny UI change. They should emit meaningful batches or coalesced observations.

## Responsibilities

System owns:

- runtime policy
- scheduling
- platform gating
- isolation
- source injection
- auth UX and credential storage
- integration state persistence
- high-throughput queue and batch policy

Connector owns:

- source-specific capture/fetch logic
- source-specific redaction
- event type and payload shape
- external id choice
- checkpoint state shape

Guard owns:

- D0 append mechanics
- source provenance on writes
- append-only event invariants
- SQLite transaction boundaries

## Built-In Connector Order

The first built-in should be `app-commits`.

Why:

- low privacy risk compared with terminal transcript capture
- clear stable `externalId` from commit SHA
- useful immediately for relating code changes to D0 history
- exercises manifest, runtime, state, and D0 source injection without auth complexity

The second built-in should be `terminal`, after capture policy is explicit:

- what counts as input, output, command, and session
- what is redacted
- how multiline commands are reconstructed
- whether output is sampled, chunked, or omitted

## Non-Goals

- no n8n-style workflow graph
- no connector-owned D2 writes
- no connector-owned schema migrations
- no outbound action connectors
- no connector-owned OAuth UI
- no raw credential injection into connector code
- no durable remote webhook delivery guarantees yet

## Current Implementation

The connector system lives in `core/src/connectors/`:

```text
core/src/connectors/
  manifest.ts       parse and validate connector.yaml / connector.json
  supervisor.ts     register, enable, launch, abort, and list connector runs
  runtime.ts        single run(context) entrypoint wrapper
  auth.ts           connector auth capability handles
  state.ts          connector integration state handles
  guard.ts          bound connector guard facade
  types.ts          public connector contract
```

The system-owned runtime state is persisted in `connector_integrations`:

```text
id / connector_id / enabled / status / config / sync_state / auth_ref
last_error / last_run_at / created_at / updated_at
```

The core invariant is implemented:

```text
connector code calls guard.writeEvent(event)
  -> events.source = connector:<instance-id>
```

Connector code does not see `ConnectorHost.emit`, `withSource`, or separate `start` / `sync` APIs.

Still pending outside the core connector system:

- shell integration management UI
- real secret-store backend beyond the injectable secret-store interface
- trigger runtime wiring for poll schedules
- worker/process-level connector isolation
- high-throughput queue and transactional batch writer
