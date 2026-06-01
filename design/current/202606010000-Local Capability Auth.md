# Local Capability Auth

Status: current implementation decision

Adiabatic is local-first, but the core server is still an HTTP process on localhost. Localhost is not a security boundary: browser pages, local tools, and sandboxed app code can all attempt requests to `http://localhost:3000`.

This matters because Guard is the substrate write boundary. If a caller can reach core without a capability, or if a read route can mutate SQLite, then D0 audit, source provenance, and app write permissions stop being trustworthy.

## Decision

Core API requests require one of two process-local capabilities:

- `ADIABATIC_CORE_TOKEN` for trusted Electron shell calls.
- `ADIABATIC_BRIDGE_TOKEN` plus `X-Adiabatic-App-Id` for WebContainer bridge calls on behalf of an app.

Electron main generates both tokens at app startup and passes them to core. The renderer gets the core token through preload. App code never receives the core token; app system calls go to the WebContainer bridge, and the bridge attaches the bridge token when forwarding to core.

The core server also restricts API requests to localhost Host headers and no longer treats `x-adiabatic-app-id` as meaningful unless the bridge token is valid.

## What Changed

- `/api/*` routes reject unauthenticated requests.
- `/api/query` is enforced as read-only by SQLite `PRAGMA query_only = ON`, not by checking whether SQL text starts with `SELECT`.
- `Guard.writeDoc` and `Guard.deleteDoc` reject unsafe doc ids, and working-tree materialization resolves doc file paths inside `pages/`.
- Shell document change subscriptions use authenticated fetch streaming instead of `EventSource`, because `EventSource` cannot send auth headers.
- CLI calls require `ADIABATIC_CORE_TOKEN`.

## Why Query-Only Enforcement Exists

`system.query` is part of the public System API and means read-only access to D0, D1, and D2. The previous implementation used `db.prepare(sql).all(...)`, which can execute mutating statements in Bun SQLite. That allowed writes through the read path, bypassing Guard's D2 permission checks and D0 audit logging.

String checks are not enough. Read-only SQL can start with `WITH` or `PRAGMA`, and some `PRAGMA` statements mutate database metadata. SQLite query-only mode is the enforcement point because it rejects actual writes regardless of SQL spelling.

## Non-Goals

This does not defend against a user or local administrator who can inspect process memory or environment variables.

This also does not complete full per-app isolation inside a shared WebContainer origin. The bridge now has a capability boundary to core, but app-to-app hard isolation remains part of the future WebContainer system module and runtime design.
