# Connector Runtime Module

Status: current module definition

This document defines the connector contract for Adiabatic OS. It follows the D0 source boundary decision: Guard owns D0 append mechanics, and connectors own source-specific capture semantics.

## Decision

A connector is a plugin runtime that turns one external or local source into D0 events.

The connector contract should not describe what kind of source the connector is. It should describe how the system can run it, authorize it, resume it, and receive D0 events from it.

```text
ConnectorHost / supervisor
  -> reads connector manifest
  -> checks package trust, platform, and auth
  -> launches a connector runner process
  -> passes bound system capabilities
  -> receives guard.writeEvent(...) calls
  -> injects source as connector:<connector_id>[:integration_key]
  -> Guard.writeEvent(...)
  -> events
```

Connector code never receives a writable DB handle, never provides `source`, and never calls `withSource()`.

## Mental Model

```text
System / core
  Guard                write boundary
  ConnectorHost        supervisor, launcher, capability issuer
  Connector registry   workspace connector discovery and package trust status
  Connector runner     process execution boundary for one connector integration
  Capability broker    host-side proxy for guard, state, warnings, auth, and source authority
  Trigger runtime      decides when poll/manual runs happen
  Shell                integration UI and auth UX
  Secret store         credentials, via external credential broker / secret store
  Official catalog     signed/hash source for official connector packages
  Integration registry installed runtime instances in .adiabatic DB
  Integration state    config, status, checkpoint, schedule in .adiabatic DB

Plugin world
  Connector manifest   static declaration
  Connector runtime    process execution unit
  Connector code       source capture/fetch/redact/normalize
```

Host is system. Connector is plugin. Built-in connectors are still plugins; they are just shipped with the system.

The key split is:

```text
connector package      installed code and static manifest
connector integration  one runtime instance of a connector package
```

A connector package can be singleton, like `app-commits`, or it can support multiple integrations, like `google-calendar` with `work` and `personal` integrations. Connector authors still write single-integration logic. The system owns integration lifecycle, credential binding, scheduling, and source scoping.

Three concepts are orthogonal and must not be merged:

```text
source identity     who the events come from: connector_id + optional integration_key
runtime target      where the integration executes: a device/host, or the official cloud
cardinality         whether the user can create more integrations (integrations.mode)
```

Singleton means one workspace-scoped source identity. It does not mean local-only, it does not mean the integration has no runtime target, and it does not mean it cannot run on cloud. `app-commits` is singleton because it observes workspace shared state — two machines running it would observe the same source, not two sources. Device-specific local collection is `multiple`: each device is a distinct source identity with its own integration. This includes `terminal` and activity watchers — two Macs' terminal sessions are different sources and must not share `connector:terminal`.

## Workspace Layout

Connector package folders live in the workspace as normal top-level folders:

```text
workspace/
  apps/
  pages/
  connectors/
  .adiabatic/
```

`connectors/` contains connector packages:

```text
connectors/
  app-commits/
    connector.yaml
    index.mjs
  google-calendar/
    connector.yaml
    index.mjs
```

Each `connectors/<connector_id>/` directory is a connector package root. The package root contains the manifest and connector entry code. The manifest id must match the folder name:

```text
connectors/app-commits/connector.yaml -> id: app-commits
connectors/google-calendar/connector.json -> id: google-calendar
```

This keeps install, remove, list, and source naming unambiguous.

`connectors/<connector_id>/` is plugin material. `.adiabatic/` is runtime/system state. The connector package should be inspectable, editable, diffable, and removable without being treated as the source of truth for runtime checkpoint data or credentials.

Folder existence is not runnable authority. A connector folder can be discovered and inspected without being allowed to execute. Runtime execution requires a trust decision based on the current package content hash:

```text
workspace/connectors/<connector_id>/
  discovered package material

.adiabatic/
  integration state
  custom human approval records
  cached official catalog metadata
```

This keeps private and user-authored connectors possible while preventing arbitrary or LLM-modified connector code from being scheduled just because a folder exists.

## Trust And Provenance

Connector v1 does not use a sandbox as its primary security model. Connectors are dynamically discovered from `workspace/connectors/*`, but only trusted package content is runnable.

The package content hash is the runtime trust key:

```text
current_hash = hash connector package files

if current_hash matches signed official catalog entry:
  status = official trusted
  badge = Official
  runnable = true

else if current_hash matches a human-approved custom hash:
  status = custom trusted
  badge = Custom
  runnable = true

else if connector was previously trusted but current_hash changed:
  status = modified
  badge = Modified / Needs Approval
  runnable = false

else:
  status = untrusted
  badge = Custom / Needs Approval
  runnable = false
```

Official status does not come from a mutable workspace DB flag. It comes from matching the current package hash against an official catalog entry whose origin is verified by the host. The official catalog is expected to be downloaded from the official R2 registry at startup, app download, or periodic update time, then cached locally for runtime lookup. A bundled catalog can be used as an offline fallback. R2 is distribution storage; the trust root should be signed catalog/package metadata or an equivalent host-verifiable official hash source.

The workspace DB may cache catalog data and records of what the workspace has seen, but it should not be the authority for saying a connector is official. It is the authority for human-approved custom hashes:

```text
connector_custom_approvals
  connector_id
  approved_hash
  approved_at
```

Custom approval is human-only. Apps, connectors, LLM tools, background jobs, and bridge APIs must not be able to silently approve a connector hash. Approval should be a shell/native user action after the user reviews the connector package. Any package change changes `current_hash`, invalidates the prior approval, and requires human approval again.

If an official connector is edited and then approved by the user, it becomes a custom trusted connector for that hash. It should no longer display the Official badge until its content hash again matches the official catalog.

Trust checks happen at execution boundaries:

```text
poll/manual
  check current hash before each run

watch
  check current hash before starting the runner process
  already-running watch processes are not continuously rehashed by default
  next restart blocks if package content changed
```

Future file watching can mark a running watch connector modified and stop it, but that is not required for the v1 trust model.

## Install, Remove, And Built-Ins

Installing a connector means adding `connectors/<connector_id>/`. Removing a connector means removing that folder.

Built-in connectors are distribution material, not a separate runtime category: bundled catalog entries that can be installed without a download. The console lists them as available; installing one is an explicit user action through the same install flow as any other connector package:

```text
desktop/template/connectors/app-commits -> workspace/connectors/app-commits   (on explicit install)
```

Nothing installs implicitly — there is no boot-time auto-materialization, so removal is final by construction and a removed built-in simply returns to the available list for explicit reinstall. Every install is recorded as `connector.installed { connector_id, package_hash }`; D0 keeps the full install/remove history. The copy is staged and renamed into place so a crash cannot leave a half-written package occupying the connector's directory.

Install is platform-agnostic: the endpoint accepts a package the current host cannot run, and the runtime marks its integration unsupported (visible, non-runnable). Platform support is a property of the runtime target, not of installation — under multi-device routing, installing here and assigning the integration to another device is a legitimate flow. The catalog UI simply hides the install action for unsupported entries in v1.

Until the official catalog ships, a freshly installed built-in classifies as untrusted and goes through the same human approve flow as any custom package — no interim trust shortcut. Once the catalog lands, the existing hash classification upgrades it to official automatically. The future download flow is the same install path with a second package source.

After materialization, the runtime treats it exactly like any other connector package location, but not all package locations are runnable. The registry scans workspace `connectors/`, validates manifests, computes content hashes, and classifies packages as official, custom trusted, modified, missing, or untrusted before any connector code is imported.

Remove semantics are also uniform:

```text
remove app-commits -> delete workspace/connectors/app-commits
```

Removing a built-in connector should not cause the system to silently restore it on the next boot. Reinstall/update should be an explicit user action.

Removing a connector package is non-destructive to runtime state by default:

```text
remove connector package
  delete connectors/<connector_id>/
  keep integration config
  keep checkpoint/state
  keep auth_ref and stored credentials
  mark integration non-runnable / missing package
  disable schedules while package is missing
```

This makes remove reversible. Reinstalling a connector with the same id can reconnect to existing config, auth, and checkpoint state.

Destructive cleanup should be a separate explicit action:

```text
purge / forget connector
  remove connectors/<connector_id>/ if present
  delete integration config and checkpoint state
  revoke/delete credentials referenced by auth_ref
  delete or disable connector schedules
  keep historical D0 events
```

Historical D0 events are append-only facts. Removing or purging a connector should not rewrite past `events`.

Upgrade policy:

- do not silently overwrite a materialized connector folder that the user may have edited
- track connector version/hash so the shell can show update availability and modified status
- update/reinstall should be explicit and should preserve or intentionally migrate `.adiabatic` runtime state
- invalid or in-progress connector folders should be reported and skipped, not crash workspace boot

## Connector Integrations

A connector integration is one runtime instance of a connector package. It is system-owned runtime state, stored under `.adiabatic`, not in the connector package folder.

```text
id               internal integration row id
connector_id      package id from connectors/<connector_id>/connector.yaml
integration_key   optional user-defined key under connector_id
```

Singleton connectors use no integration key:

```text
connector_id: app-commits
integration_key: null
events.source: connector:app-commits
```

Runnable multiple-integration connectors require a user-defined key:

```text
connector_id: google-calendar
integration_key: work
events.source: connector:google-calendar:work

connector_id: google-calendar
integration_key: personal
events.source: connector:google-calendar:personal
```

The integration key is not inferred by the system. It is chosen by the user when creating the integration. It is also the user-facing integration name. The system only validates it:

```text
pattern: [a-z0-9][a-z0-9-]*
unique within connector_id
stable after creation unless an explicit rename/migration exists
```

Auth provider metadata, such as an email address, can help the UI explain which account was connected, but it should not silently decide the integration key or become part of D0 source provenance.

Integration rows can temporarily exist in setup state before they are runnable. A setup row gives the UI somewhere to attach auth, config, and requirement progress, but it must not run or emit D0 events until the integration has a valid source identity:

```text
singleton integration
  source identity is valid with integration_key = null

multiple integration
  source identity is valid only after user sets integration_key
```

Integration lifecycle:

```text
install connector package
  add connectors/<connector_id>/
  compute package hash
  classify official/custom trust status
  ensure the first integration row
  copy runtime.defaultSchedule into the integration schedule

discover untrusted connector package
  add or find connectors/<connector_id>/
  load manifest and compute package hash
  mark as custom / needs approval
  do not schedule or run until human approval

human approve custom connector package
  record connector_id + current package hash
  allow runs until package content changes

create integration
  add another runtime instance under connector_id
  only available when integrations.mode is multiple
  bind config, auth_ref, schedule, and state namespace

remove integration
  stop scheduling and running that runtime instance
  keep or purge runtime/auth data according to explicit user action

uninstall connector package
  delete connectors/<connector_id>/
  keep integrations as non-runnable / missing package

reinstall connector package
  reconnect existing integrations with matching connector_id
  recompute package hash and trust status
```

Install always creates or ensures the first integration. Singleton and multiple connectors do not have different first-integration flow. The integration may be immediately runnable or may be in setup, depending on auth, config, platform requirements, and source identity requirements.

For singleton connectors, the UI should not expose "Add account" or "Create integration" because there can only be one integration. If auth is required, the user flow is "Connect", which binds credentials to that integration.

For multiple-integration connectors, the same first integration appears after install. The UI can show it as "Needs setup" or "Not connected" until the user provides the required integration key, config, auth, and platform requirements. The same connector management UI can also expose "Add integration" or "Add account" for additional integrations.

`integrations.mode` controls source identity cardinality, not runtime placement and not whether the first integration exists. Auth type, required config, active platform requirements, and source identity determine whether the first integration needs a connect/setup flow.

## Runtime Target

Every integration is one source identity assigned to exactly one runtime target.

```text
An integration never runs on more than one runtime target.
A runtime target has exactly one platform (darwin / ios / android / cloud / ...).
Manifest platforms are compatibility declarations for target selection, not runtime identity.
```

`platform` answers "can this connector run on this kind of target, and with which requirements". `runtime target` answers "which device/host actually owns this integration's execution". Two Macs are both `darwin` but are different runtime targets. `cloud` is the official managed execution platform, treated as a special target; a local host must not declare itself as cloud.

Because one integration binds to one target, multiple manifest platforms are alternative placements, never simultaneous lanes. Multi-device collection is expressed as multiple integrations (one per device), not as one integration running in multiple places. A `platformMode: exclusive | additive` manifest field was considered and rejected; it is unnecessary under this model.

v1 implementation rule — the runtime target is implicit:

```text
current implementation
  the only runtime target is the current host process
  no devices table
  no connector_integrations.runtime_device_id column
  active platform requirements are selected by the current host platform
```

There is no persisted host binding in v1, so there is no such thing as "registered on this host". Multi-host or shared-DB connector execution is unsupported until `runtime_device_id` exists: if the same workspace DB were synced to two hosts today, both would treat every ready integration as locally runnable. That is out of scope, not handled.

Do not implement multi-device target routing now. The backing registry is not connector-specific: it is a workspace `devices` table that will exist as the foundation for multi-device sync (device identity, presence, platform, status). Connector integrations merely reference a device as their runtime target. Reserved future schema, used only when the "Multi-device runtime target routing" TODO is picked up:

```text
devices (
  id TEXT PRIMARY KEY,      -- "local:<host-id>", "cloud:adiabatic"
  platform TEXT NOT NULL,   -- darwin / ios / android / cloud
  label TEXT NOT NULL,
  status TEXT NOT NULL,
  metadata JSON,
  updated_at INTEGER NOT NULL
)

connector_integrations.runtime_device_id TEXT
```

Future semantics: `runtime_device_id -> devices.id`; requirements come from `manifest.platforms[device.platform]`; only the host that owns the device may run that integration. The official cloud runtime is represented as a special device row, not a separate concept.

## Connector Manifest

The manifest is the static plugin declaration. It is file-based so it is easy to inspect, review, version, and modify.

The manifest lives at the connector package root:

```text
connectors/<connector_id>/connector.yaml
connectors/<connector_id>/connector.yml
connectors/<connector_id>/connector.json
```

```yaml
id: app-commits
name: App Commits
entry: ./index.mjs
runtime:
  mode: watch
integrations:
  mode: singleton
platforms:
  darwin: {}
  linux: {}
  windows: {}
auth:
  type: none
```

Poll connector example:

```yaml
id: google-calendar
name: Google Calendar
entry: ./index.mjs
runtime:
  mode: poll
  defaultSchedule: "*/15 * * * *"
integrations:
  mode: multiple
platforms:
  darwin: {}
  linux: {}
  windows: {}
  ios: {}
  android: {}
  cloud: {}
auth:
  type: oauth2-public
  authorizationEndpoint: https://accounts.google.com/o/oauth2/v2/auth
  tokenEndpoint: https://oauth2.googleapis.com/token
  clientId: calendar-client-id
  scope:
    - https://www.googleapis.com/auth/calendar.readonly
```

The manifest declares what the system needs to know:

- `id` and `name`
- `entry`
- runtime mode and default schedule
- integration cardinality
- structured platform compatibility and requirements
- auth type
- config schema — the user-facing config fields, their types, labels, and author defaults

The manifest id must match the containing folder name. `entry` is resolved relative to the connector package root and must stay inside that root.

The manifest holds **no mutable runtime state** — no secrets, auth tokens, enabled/disabled status, or sync checkpoints. Those would turn the trust-hashed package into a settings store, making every change a re-approval. What it *does* declare for config is a **config schema**: each user-facing field with its `type`, `label`, and author **`default`**. User-chosen values are stored as **overrides in integration config**, never in the manifest. At run time the host composes the effective config as `schema defaults → integration overrides → one-off run override`. The connector folder is plugin material, not runtime state.

### What belongs in config

Config is a user-facing surface, not a place for every parameter. A value should be `config` **only if both hold**:

1. **The user understands it** — it maps to something the user has a mental model of (which account, which calendar, which folder, how far back to import), not an implementation detail (buffer sizes, retry backoff, field delimiters, log format, endpoint versions).
2. **Adjusting it has real UX meaning** — different users would genuinely want different values, and changing it visibly changes behaviour the user cares about.

If a value passes both, declare it in the **config schema** with its `default`. Because config is by definition user-facing, its default is **shown to the user** — the setup form renders it and "reset" restores it — not hidden in code. A value that fails either test — the 5s watch tick in `app-commits`, a parser's record separator — is **not** config: it is a plain constant in the connector code, never declared and never surfaced. So `??`-with-a-literal-default goes away for config fields (the host supplies the schema default at run time); a literal default in code remains only for non-config internals, which are just ordinary constants.

When in doubt, start as a code constant. Promoting it to config later — declaring it in the schema — is cheap; demoting a config the user has already set is a migration.

### Setup UI: config and auth are separate surfaces

The shell renders setup as two distinct components, because they map to two different things:

- **Config component** — a form generated from the connector's config schema. Plain settings: values are shown, freely editable, and resettable to the declared default. Stored as integration-config overrides.
- **Credential component** — rendered by `auth.type` (an API-key field, or an OAuth connect flow). Credentials are secrets: handled by the credential broker / secret store, stored encrypted, never displayed back. The UI signals sensitivity (masked input, "stored encrypted", connect/revoke) so the user knows they are handing over a key, not setting an option.

Keeping them separate is also a boundary guard: secrets always flow through the auth component into the encrypted store, never into the config schema. A connector declaring neither shows neither — the surface is driven entirely by the manifest.

`runtime.defaultSchedule` is only valid for `poll` connectors. It is a creation default for new integrations, not the scheduler's long-term source of truth. When an integration is created, the system copies the default into the integration schedule. After that, the scheduler reads the integration's own schedule.

`integrations.mode` is required and must be declared explicitly. There is no default: under the source-scope semantics, defaulting to `singleton` would silently make the source-scope decision for the author, and a device-scoped connector accidentally shipped as singleton corrupts source provenance across devices. It declares source identity cardinality only. Use `multiple` when the same connector package naturally supports multiple source identities, such as separate accounts, separate devices, or source scopes. Device-specific local collectors must be `multiple` because each device is a distinct source identity.

## Runtime Modes

Mode classifies **how the runtime is triggered to invoke the connector** — the trigger axis, not what the connector does. It is package-level host/scheduler metadata; connector code still has one entrypoint.

```text
watch   self-driven: the connector holds a long-lived loop or outbound
        connection and emits as data arrives; exits when the signal aborts
poll    runtime-driven on a schedule: one pass that syncs since its cursor and returns
manual  on-demand: runs only on an explicit trigger with a bounded input;
        never auto-scheduled
```

`push` (inbound: the provider calls a public receive endpoint you host) is a future fourth mode, gated on the hosted relay — localhost has no inbound endpoint. The split is **who initiates the connection**: outbound (you dial out and hold it) is `watch`; inbound (the provider dials you) is `push`.

Examples:

- `watch`: terminal, app-commits watcher, macOS accessibility capture; and all *outbound* realtime — WebSocket, long-poll, Slack Socket Mode, Telegram getUpdates — because the connector dials out and holds the connection, so no public endpoint is needed.
- `poll`: Google Calendar, Oura, GitHub API.
- `manual`: a connector whose *entire* nature is on-demand — a bounded archive/export that yields events, or a one-time extraction of old material into D0 facts.

A one-time **backfill of a live source** (e.g. Oura history) is **not** `manual`. It is a one-off triggered run on the underlying `poll`/`watch` connector, which branches into its backfill path. `import` is an *operation* — a triggered run with input, available to any connector — not a mode; `manual` is reserved for connectors that *only* ever run on demand.

Do not add `stream` as a separate mode yet. High-throughput streams are watch connectors with batching and backpressure policy.

Mode is not user-editable in the integration UI because it is coupled to the connector code contract. Schedule is integration runtime policy and can be user-editable later.

Trigger semantics:

```text
watch connector
  core up -> start enabled ready watch integrations on the current implicit runtime target
  core down -> stops
  run crash -> status error, needs attention; restart is an explicit human action

poll connector
  core up -> scheduler evaluates due integration schedules
  core down -> no execution
  next core startup -> due integrations run once as catch-up
  run crash -> surfaced as needs-attention; still retried at the next due schedule

manual connector
  never auto-run by the scheduler (not started on core up, not scheduled)
  runs only on an explicit run-now trigger (host run endpoint -> supervisor.run),
    shown in the shell as a Run button; the trigger carries the bounded input
  run-now is the only execution path for a manual connector, and is also how any
    connector takes a one-off on-demand run (e.g. a poll connector's backfill)

Any run error is surfaced to the user as needs-attention — an error is by
nature something the user should see. The runtime recovery behavior differs by
mode: watch runs are deliberately not auto-retried (a connector bug should
surface, not burn quietly in a retry loop), while poll runs keep retrying on
their schedule. `restartIntegration` / `POST
/api/connectors/integrations/:id/restart` resets the error back to idle — for
watch this restarts the run, for poll it forces an immediate retry (next_run_at
cleared). Setup-blocked errors (revoked credentials, regressed requirements)
recover automatically through the setup promotion path instead.
```

Missed cron ticks collapse into one catch-up run. Connectors should use state cursors to catch up source data.

## Runtime Components

The connector runtime is split into explicit host-owned components:

```text
WorkspaceConnectorRegistry
  scan workspace/connectors/*
  load and validate manifest
  resolve entry path
  compute package content hash
  classify package trust status
  register trusted package metadata
  never import connector code before trust passes

ConnectorIntegrationStore
  read/write .adiabatic DB connector_integrations
  owns config, state, warnings, auth_ref, schedule, status, and timestamps

ConnectorSupervisor
  public orchestration API
  install/remove/register/list/ensureIntegration/run/start/abort/restart
  coordinates registry, integration store, runner, and scheduler

ConnectorRunner
  runs exactly one integration execution
  builds scoped connector context
  checks trust, platform requirements, auth, setup state, and source identity
  injects bound guard source
  imports connector entry after trust and auth gates pass
  evaluates requirement handlers after import, before run(context)
  calls run(context)

ConnectorScheduler
  reads integration schedules
  starts poll runs when due
  starts watch connectors on core up
  stops watch connectors on core down
```

`ConnectorRunner` is a separate process runner: every workspace package connector executes in a spawned Bun child with an IPC capability broker. The child has no database handle, no Guard, and no secrets — `guard.writeEvent`, `state.get/set`, `warnings.set/clear`, and `auth.getToken` are RPC calls served by the host, where source injection, validation, and system-state writes happen. Requirement `check`/`request` handlers also execute in the child. Abort is cooperative first (AbortSignal in the child), then enforced: a runner that ignores abort is force-killed after a grace period. This is not a sandbox claim. The process boundary exists for connector lifecycle, crash isolation, cancellation, and future runner backend flexibility. Trust still comes from official hash/signature verification or human-approved custom hashes, verified by the host before any spawn. Manually registered in-memory definitions (tests, embedding) run in-process with identical semantics.

```text
poll/manual
  host checks trust
  spawn runner process
  run once
  exit

watch
  host checks trust
  spawn long-lived runner process
  abort/kill on core stop, disable, remove, or restart
```

The runner process does not receive a DB handle, raw secret store, source authority, or scheduler internals. It receives IPC-backed capability proxies that preserve the connector-facing contract.

## Capability Broker

The capability broker is the host-side authority layer between a connector runner process and the core substrate.

Connector code still sees:

```ts
run({ guard, auth, state, warnings, config, host, signal })
```

But inside a runner process these handles are IPC proxies:

```text
connector code
  guard.writeEvent(event)
    -> IPC
    -> host capability broker
    -> validate event
    -> inject source
    -> Guard.writeEvent(...)

connector code
  state.get/set(...)
    -> IPC
    -> host capability broker
    -> scoped integration state

connector code
  warnings.set/clear(...)
    -> IPC
    -> host capability broker
    -> scoped integration warning state

connector code
  auth.getToken()
    -> IPC
    -> host capability broker
    -> external credential broker / secret store
```

`host.workspacePath` and `host.lamarckApiOrigin` are host-owned runtime context. They must be supplied uniformly by the connector host, not patched into integration config and not special-cased by connector id. `lamarckApiOrigin` is optional because non-Lamarck connectors and older hosts do not need it; official managed-provider connectors use it to target the current dev/prod Lamarck backend instead of hard-coding `api.lamarck.ai`.

The broker owns:

- D0 write validation and source injection
- integration-scoped state access
- integration-scoped warning access
- auth token access and refresh
- trust/run gate enforcement for active runs
- cancellation and run status reporting

This keeps connector code from receiving ambient authority while preserving a small author-facing API.

## Connector Code Contract

Connector code should expose one run entrypoint.

```ts
export default defineConnector({
  async run({ guard, auth, state, warnings, config, host, signal }) {
    // Capture, fetch, redact, normalize.
    await guard.writeEvent({
      type: "source.event",
      externalId: "upstream-id",
      startedAt: Date.now(),
      payload: {},
    });

    await state.set({ cursor: "next" });
    await warnings.clear("backfill");
  },
});
```

For v1, connector package entries are JavaScript ESM modules loaded from `entry`. Official connectors can be authored in TypeScript, but installed package material should expose a built ESM entry. Other languages require a future runner backend and are not part of the current connector contract.

The public context is intentionally small:

```ts
type ConnectorRunContext<TConfig, TState> = {
  guard: BoundConnectorGuard;
  auth: ConnectorAuthHandle;
  state: ConnectorStateHandle<TState>;
  warnings: ConnectorWarningsHandle;
  config: TConfig;
  host: ConnectorHostContext;
  signal: AbortSignal;
};

type ConnectorHostContext = {
  workspacePath: string;
  lamarckApiOrigin?: string;
};
```

The connector author should only need to understand:

- `guard.writeEvent(...)`
- `auth` as a capability handle
- `state` as private checkpoint storage
- `warnings` as keyed non-fatal status for shell-visible integration attention
- `config` as the integration's settings (plus any one-off run override); package defaults live in the connector's own code
- `host` as stable host-owned runtime context
- `signal` for cancellation

They should not need to understand host internals, `withSource()`, app identity, DB handles, scheduler internals, or shell auth UX.

Do not expose integration identity in the connector context by default. The host already scopes `guard`, `auth`, `state`, `warnings`, and `config` to the current integration. Most connector code should not care whether it is running for `work`, `personal`, or a singleton runtime instance.

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
  externalId: string;
  startedAt: number;
  endedAt?: number;
  payload: JsonValue;
};
```

`JsonValue` means JSON-serializable data: `null`, string, finite number, boolean, arrays, and plain objects. The payload does not have to be an object. Runtime validation rejects `undefined`, functions, `BigInt`, circular references, and non-plain objects.

For connector-facing writes, `externalId` is required. It is the stable idempotency key for the source item within the bound connector source. Poll retries, catch-up runs, and connector restarts must produce the same `externalId` for the same upstream item. If the upstream system does not expose a native id, the connector must derive a deterministic key from stable source identity such as URL, path, commit SHA, provider object id, or a hash of those fields.

At the connector guard boundary, a duplicate `(source, externalId)` is a no-op that returns the existing event id. This does not update or rewrite D0. It only means the upstream item has already been materialized into append-only D0, so connector retry should not fail on the database dedup index. This idempotent duplicate handling is connector-facing behavior, not necessarily the global behavior of raw `Guard.writeEvent()`.

The runtime injects source from connector id plus optional integration key.

Singleton integrations:

```text
connector:app-commits
```

Multiple integrations:

```text
connector:google-calendar:work
connector:google-calendar:personal
connector:terminal:macbook
```

This matters because D0 dedup is keyed by `(source, external_id)`. The connector author never provides source or integration key, but they must provide the per-item external id. Core D0 may still allow nullable `external_id` for non-connector/system events; the connector contract should not.

## Auth

Auth is system-managed. Connectors declare standardized credential or account requirements; host and shell implement the flow. Auth covers flows the system can reasonably standardize across connectors:

```text
none
apiKey
oauth2-public
managedProvider
```

Secret material belongs to the external credential broker / secret store, not to `connectors/<connector_id>/` and not to connector-owned files.

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
  type: oauth2-public
  authorizationEndpoint: https://accounts.google.com/o/oauth2/v2/auth
  tokenEndpoint: https://oauth2.googleapis.com/token
  clientId: calendar-client-id
  scope:
    - https://www.googleapis.com/auth/calendar.readonly
```

```yaml
auth:
  type: managedProvider
  providerId: oura
```

The auth manifest type selects the setup/exchange flow. `oauth2-public` is the only direct OAuth flow: author-owned public client, local loopback receiver, and PKCE always on. `managedProvider` is the official Lamarck-managed provider contract for confidential or provider-specific OAuth; provider OAuth metadata, client secrets, refresh-token custody, provider quirks, and provider API proxying live in Lamarck hosted services, not the local manifest. See [External Credential Broker and Secret Store](202606150000-External%20Credential%20Broker%20and%20Secret%20Store.md).

Connector code receives an auth capability handle, not raw credential state. Each connector integration may store an `auth_ref`, but that is only a pointer into the external credential broker / secret store. `apiKey` returns a local user secret, `oauth2` returns a direct public OAuth provider token, and `managedProvider` returns a short-lived Lamarck capability token for Lamarck's provider API. Managed-provider capability tokens are scoped to the current `integrationId`, `providerId`, and `/providers/{providerId}/v1/*`; they are not desktop session tokens and they are not provider OAuth tokens.

```ts
type ConnectorAuthHandle =
  | { type: "none" }
  | {
      type: "apiKey" | "oauth2" | "managedProvider";
      getToken(): Promise<string>;
    };
```

Managed provider connector code calls Lamarck's backend API, not the upstream provider with a provider OAuth token:

```ts
const token = await context.auth.getToken();
const apiOrigin = context.host.lamarckApiOrigin ?? "https://api.lamarck.ai";

await fetch(`${apiOrigin}/providers/oura/v1/streams/daily_activity`, {
  headers: { Authorization: `Bearer ${token}` },
});
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

- `app-commits`: last seen commit SHA per app repo.
- `google-calendar`: sync token.
- `oura`: last synced day.
- `terminal`: current session checkpoint or last flushed chunk pointer.
- `manual`: last imported file hash or offset.

State is not product data, not D0, and not secret storage. It is runtime bookkeeping so the connector can resume.

Persisted state belongs in `.adiabatic/system.db`, in a system-owned integration table, not in connector YAML or the workspace connector folder. It is scoped per integration. Connector runtime state is workspace-owned control-plane data; connector-produced D0 events still go through Guard into `.adiabatic/data.db`.

## Warnings

Warnings are non-fatal connector diagnostics that should be visible in shell UI without turning the integration into a failed run.

```ts
type ConnectorWarningsHandle = {
  set(warning: ConnectorWarningInput): Promise<void>;
  clear(key: string): Promise<void>;
};

type ConnectorWarningInput = {
  key: string;
  message: string;
  details?: JsonValue;
};
```

Warnings are keyed current state, not an append log. `set()` upserts by key: repeated writes update `message`, `details`, and `lastSeenAt` while preserving the original `firstSeenAt`. `clear()` removes that key and is a no-op if the key is absent. Successful runs do not automatically clear warnings; the connector must clear the warning when the condition is resolved.

Use warnings for recoverable or secondary work that should not mask the primary sync path, for example: historical backfill paused after a provider rate-limit while the six-hour incremental sync still succeeds. Do not use warnings for hard run failures; throw from `run()` so the supervisor records `status = error` and `last_error`.

Warnings are control-plane state in `connector_integrations.warnings`. They are not product data, not D0 events, and not a replacement for `state` cursors. D0 must not receive operational warning events such as `oura.backfill.error`; those belong in system DB current state.

## Platform Requirements

Platform compatibility and platform-coupled setup requirements belong together in the manifest.

```yaml
platforms:
  darwin:
    requirements:
      - macos-accessibility
  windows:
    requirements:
      - windows-ui-automation
  linux: {}
```

Each key under `platforms` declares support for that platform. An empty object means the connector supports the platform without extra setup requirements.

Multiple platform keys are alternative placements for target selection, not simultaneous runs. The active platform entry is the one matching the integration's runtime target platform (v1: the current host platform). Requirements are never unioned across platforms; only the active platform entry's requirements are checked.

Requirements are connector-specific setup gates, not system auth backends. They cover local permissions, platform APIs, source-specific setup, or other prerequisites that are too platform-coupled or source-specific for the substrate to implement directly.

Example local connector:

```yaml
id: macos-ax
name: macOS Accessibility
entry: ./index.mjs
runtime:
  mode: watch
integrations:
  mode: multiple # device-scoped: each Mac is a distinct source identity
platforms:
  darwin:
    requirements:
      - macos-accessibility
auth:
  type: none
```

The connector package provides handlers for requirement ids:

```ts
export const requirements = {
  "macos-accessibility": {
    label: "Accessibility",
    description: "Required to observe active windows and UI events.",

    async check(ctx) {
      return {
        status: "missing",
        message: "Accessibility access is not granted.",
      };
    },

    async request(ctx) {
      return {
        status: "pending",
        message: "Grant access in System Settings.",
      };
    },
  },
};
```

Minimal requirement handler contract:

```ts
type RequirementStatus =
  | { status: "satisfied"; message?: string }
  | { status: "missing"; message?: string }
  | { status: "pending"; message?: string }
  | { status: "error"; message: string };

type RequirementHandler = {
  label: string;
  description?: string;
  check(ctx: RequirementContext): Promise<RequirementStatus>;
  request?(ctx: RequirementContext): Promise<RequirementStatus>;
};
```

System behavior:

```text
load manifest
select current platform entry
for each requirement id:
  load connector requirement handler
  call check()
  if not satisfied, keep integration in setup / needs requirement

user clicks Grant / Set Up
  call request() if present
  call check() again

before run
  call check() for active platform requirements
  if any requirement is not satisfied, block run
```

This keeps substrate responsibility small. The system owns lifecycle, setup UI shell, status storage, and run gating. The connector owns platform-specific check/request implementation, labels, help text, settings links, and source-specific setup behavior.

The host decides whether a connector can be enabled or run on the current platform. A macOS-only connector should simply not run on mobile. Mobile can have separate connector runtimes and platform-specific connectors.

## Integration State

Connector package definition and connector integration state are separate.

```text
connectors/<connector_id>/connector.yaml
  static package declaration and code package

.adiabatic/system.db connector_integrations table
  id / connector_id / integration_key / enabled / status
  config / sync_state / auth_ref / schedule_cron
  last_error / warnings / last_run_at / next_run_at

.adiabatic/system.db connector_custom_approvals table
  connector_id / approved_hash / approved_at

.adiabatic cached official catalog metadata
  locally cached official id/version/hash/signature data
  downloaded from official registry / R2
  not the authority by itself unless host verification passes

connectors/<connector_id>/ removal
  removes the installed connector package

external credential broker / secret store
  tokens and API keys

D0 events
  connector integration output
```

The tables are system state, not plugin code. They support shell UI, status inspection, trust gating, retries, scheduling, and reconnect/disconnect UX. Deleting `connectors/<connector_id>/` removes the installed package; it does not rewrite historical D0 events or blindly delete system-owned runtime rows.

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
- connector package discovery
- trust classification and run gating
- process runner lifecycle
- capability broker
- source injection
- auth UX and credential storage
- requirement setup UI shell and run gating
- integration lifecycle
- integration state persistence
- high-throughput queue and batch policy

Shell owns:

- human-only custom connector approval UX
- official/custom/modified/missing status display
- review surfaces before approving a custom package hash

Connector owns:

- source-specific capture/fetch logic
- source-specific redaction
- platform requirement check/request handlers
- event type and payload shape
- external id choice
- checkpoint state shape

Guard owns:

- D0 append mechanics
- source provenance on writes
- append-only event invariants
- SQLite transaction boundaries

Official registry owns:

- official connector catalog metadata
- approved package hash/version/signature records
- downloadable connector distribution artifacts

## Built-In Connector Order

The first built-in should be `app-commits`.

Why:

- low privacy risk compared with terminal transcript capture
- clear stable `externalId` from commit SHA
- useful immediately for relating code changes to D0 history
- exercises manifest, runtime, state, and D0 source injection without auth complexity
- can be shipped as built-in material, then copied to `connectors/app-commits`
- can be marked Official when its package hash matches the official catalog

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
- no connector-owned multi-account lifecycle
- no substrate-owned catalog of every platform permission flow
- no raw credential injection into connector code
- no durable remote webhook delivery guarantees yet
- no sandbox as the v1 connector security model
- no automatic approval for custom or modified connector code
- no mutable DB flag that can make a connector official
- no app, connector, LLM, or bridge API path for human-only connector approval
- no automatic retry/backoff for crashed watch runs; crash is needs-attention, restart is explicit
- no `platformMode` (additive multi-platform lanes); one integration runs on one runtime target
- no `longRunning` host capability flag; locals do not self-declare as cloud
- no multi-device runtime target routing in v1; the runtime target is the implicit current host

## Current Implementation

The connector system lives in `desktop/core/src/connectors/`:

```text
desktop/core/src/connectors/
  manifest.ts       parse and validate connector.yaml / connector.json
  registry.ts       package hashing, official/custom/modified trust classification, custom approval records
  supervisor.ts     register, enable, launch, abort, and list connector runs
  runtime.ts        single run(context) entrypoint wrapper
  auth.ts           connector auth capability handles
  state.ts          connector integration state handles
  guard.ts          bound connector guard facade
  types.ts          public connector contract
  schedule.ts       cron parsing and schedule validation
  scheduler.ts      starts watch integrations and runs due poll integrations
  install.ts        install/remove/materialize connector folders in workspace connectors/
  process-runner.ts host-side runner sessions: spawn, IPC capability broker, abort/kill
  runner-child.ts   runner process entrypoint: imports the package, proxies capabilities
  runner-protocol.ts IPC message contract between host and runner
```

The target system-owned runtime state is persisted in `connector_integrations`:

```text
id / connector_id / integration_key / enabled / status / setup_status
trust_status / package_hash / schedule_cron / next_run_at / config
sync_state / requirements_status / auth_ref / last_error / warnings / last_run_at
created_at / updated_at
```

The core invariant:

```text
connector code calls guard.writeEvent(event)
  -> singleton events.source = connector:<connector_id>
  -> multi-integration events.source = connector:<connector_id>:<integration_key>
```

Connector code does not see `ConnectorHost.emit`, `withSource`, or separate `start` / `sync` APIs.

The requirement lifecycle is implemented in core: connector packages export `requirements` handlers (`check`/`request`), the supervisor exposes `checkIntegrationRequirements` / `requestIntegrationRequirement` (separate from auth connect), requirement status persists in `connector_integrations.requirements_status`, `/api/connectors` exposes per-integration requirement status, and a unified setup evaluator gates `ready` (source identity + auth + active platform requirements). Handlers are only loaded after the package passes the same trust gate as `run()`, and every run re-checks credentials and active requirements before `run(context)` is called. Note the precise timing: module top-level code executes at import inside the runner process, after the trust gate and before the requirement check — the requirement gate protects the run, the trust gate protects the import, and the process boundary contains whatever the import does.

Already implemented in core (not pending): workspace trust gate, package content hashing, official/custom/modified classification, custom approval records, and the host-auth approve endpoint.

The shell ships a connector management surface (Source Console): per-integration status, the run gate chain, requirement check/grant actions, two-step custom package approval showing the exact package hash, and explicit restart for crashed watch runs.

Still pending outside the core connector system:

- cached official catalog download/verification from the official registry / R2 (until then nothing classifies as official)
- external credential broker / secret store adapter beyond the current injectable secret-store interface
- high-throughput queue and transactional batch writer
