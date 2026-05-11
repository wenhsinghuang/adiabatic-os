# Design Pattern: Native Primitives, Guard Boundaries, KISS

Status: current design preference

This document captures a recurring Adiabatic OS design pattern. It is not a product spec and should not be treated as a final API contract. It exists to guide future design work and keep implementation choices aligned with the project's bias.

## Core Preference

Prefer native primitives over invented abstractions.

Use the things developers and LLM coding agents already understand:

- SQL for D2 data mutation
- DDL for schema changes
- Git for app code history
- filesystem working trees for editable mirrors
- ordinary web / Node / TypeScript app layout
- open JSON payloads for event-specific data

Avoid DSLs, framework-heavy wrappers, and product-specific concepts unless the native primitive cannot satisfy an essential system property.

The essential system properties are:

- authority
- source identity
- permission boundaries
- auditability
- replayability
- sandbox isolation
- future schema evolution

If an abstraction does not protect one of these, it is probably premature.

## Boundary Rule

Apps should feel free-form. Guard should be strict.

The app authoring surface should remain close to normal development:

```text
apps/<id>/
  .git/
  manifest.json
  package.json
  src/...
```

An app can be a normal React / TypeScript / Node project. It should not need to learn a large Adiabatic-specific DSL to be useful.

The safety boundary belongs below the app:

```text
App code
  -> @adiabatic/system
  -> runtime bridge injects source
  -> Guard validates permissions and operation class
  -> SQLite
  -> D0 audit log
```

The app may request native-looking operations. Guard decides what is allowed.

## SQL Rule

Keep raw SQL for ordinary D2 writes.

Ordinary app writes should use:

```ts
system.write(sql, params)
```

Guard restricts this to a safe DML subset:

- `INSERT`
- `UPDATE`
- `DELETE`
- one statement
- non-system tables only
- manifest write grants required

Do not replace raw SQL with a structured CRUD DSL unless raw SQL makes replay/audit impossible in practice.

Replay and audit should be handled by Guard using CDC-style payloads in D0, not by forcing app authors into a weaker API.

## DDL Rule

Keep schema changes close to raw DDL, but route them through privileged APIs.

Use only two top-level lifecycle directions:

```text
promote = increase structure
demote  = decrease structure
```

The interface should allow raw DDL lists plus Guard allowlists, approval, transactionality, and D0 audit.

Avoid an operation DSL unless raw DDL becomes unmanageable. Merge should not become a third primitive by default; it is usually a demote/restructure action that reduces redundant structure.

## Event Schema Rule

Keep the event table small.

Only add first-class columns when the field is truly unavoidable as a primary query, ordering, deduplication, or provenance axis.

Current hard columns:

- `id`
- `schema_version`
- `source`
- `type`
- `external_id`
- `started_at`
- `ended_at`
- `payload`
- `created_at`

Everything else should start inside `payload`.

Do not add a `metadata` column just because metadata is a common event-sourcing pattern. If Guard needs runtime trace details, app version, run id, or internal provenance, Guard can encode that inside payload internally. Do not expose unstable conventions in public docs until they are worth committing to.

## Docs vs Code Rule

Do not document provisional conventions as if they are product concepts.

If a convention is internal, unstable, or only useful to Guard, encode it in code first. Public docs should describe only the stable contract we want app authors and agents to rely on.

Examples:

- Good public contract: events have open JSON payloads.
- Bad premature contract: apps should use `payload._meta` keys.
- Good implementation detail: Guard may write internal trace data into payload.

Documentation creates dependency. Use it deliberately.

## Source Rule

Callers do not supply source.

Runtime / Guard injects source:

```text
app:<id>
connector:<id>
working-tree:pages
system:<component>
```

This is not optional. Source is provenance and must not be forgeable by app code.

## Git Rule

Use Git for app code, not substrate data.

Adiabatic data history lives in D0. `pages/` is a D1 working tree mirror, not the source of truth.

Each app should have its own Git repo:

```text
apps/<id>/.git
```

Workspace root Git is not the default model. It only becomes relevant if the project later needs a whole-workspace filesystem bundle. Until then, root Git would blur the boundary between app code history and substrate data history.

## Working Tree Rule

SQLite / D0 is the source of truth. Files are mirrors or authoring surfaces.

For `pages/`:

```text
DB -> files: materialization, not a new source
files -> DB: external edit, source = working-tree:pages
```

Use last-write-wins for v0.1. Collaborative/conflict-aware doc history can come later through Yjs or another document-specific mechanism.

## Decision Rule

When a design is uncertain, ask before committing it.

The default stance:

1. Use native primitive.
2. Add Guard/runtime enforcement only where needed.
3. Keep event schema small.
4. Keep provisional behavior in code, not docs.
5. Promote to public contract only after repeated use proves it necessary.

Any proposal that adds a DSL, a new first-class column, a new public convention, or a non-native package/update model must justify why native primitives are insufficient.
