# System Database Separation — Substrate vs Control-Plane

Status: current refactor decision

This is a substrate-level refactor, not an auth feature. Auth is one beneficiary; the problem predates it.

**This doc is the single canonical owner of storage layout** — which table lives in which database (`data.db` vs `system.db`). Other docs (the D0/D1 schema doc, Connector Runtime Module) describe table *shapes* and *semantics* but defer the *placement* question here; the literal definitions live in `desktop/core/src/db.ts`. When the boundary changes, update this doc, not the restatements.

## Context

Adiabatic keeps everything in one SQLite database in `.adiabatic/`: the user substrate (`D0` / `D1` / `D2`) and the system's own control-plane tables (`connector_integrations`, `connector_custom_approvals`, …). The app read path (`/api/query`) calls a table-agnostic, read-only `Guard.query` for every authenticated caller — there is **no app-aware read filter**. So any table in the shared file is reachable by app code today: an app can already `SELECT * FROM connector_integrations`. This exposes system control-plane state to app code, and it would expose credential ciphertext/metadata the moment credential tables are added to the same file.

## Decision

Split storage into two databases by **access**, not by sync:

- **data DB** — `D0` / `D1` / `D2`. The user substrate. Written through **Guard**, read by apps via `/api/query`.
- **system DB** — the control plane: connector tables (`connector_integrations`, `connector_custom_approvals`, …), credential tables (`auth_*`), and any future system-internal state. Written by **core modules** (the supervisor, the credential broker), never app-readable.

The app read/write paths open **only the data DB**. The system DB is therefore unreachable by app code **by construction** — structural isolation, not a denylist that must be maintained as new system tables appear. New control-plane tables land in the system DB and are automatically out of app reach.

This closes the pre-existing connector-table exposure and removes the need for any per-table app-read filter.

## Scope notes

- This is about **access** (who can read), not **sync**. Whether parts of the system DB sync across devices (e.g. auth ciphertext, for multi-device) is a separate, later decision; the access split does not constrain it.
- **Ownership lines:** Guard owns the data DB (the substrate write path); core control-plane modules own the system DB. Apps reach the data DB through the capability-gated `/api/query` and `/api/write`; they never get a handle to the system DB.
- Relation to [Local Capability Auth](202606010000-Local%20Capability%20Auth.md): that decision governs *whether* a caller may reach core; this one ensures that even an authorized app caller cannot read control-plane tables, because its query connection is scoped to the data DB.

## Consumers

- [External Credential Broker and Secret Store](202606150000-External%20Credential%20Broker%20and%20Secret%20Store.md) — credential tables live in the system DB and are app-unreadable by virtue of this split. Standing up the system DB is a prerequisite for adding any credential table.
- Connector runtime — the connector control-plane tables move to the system DB, closing their current exposure.
