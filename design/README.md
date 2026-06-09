# Adiabatic OS — Design Index

Adiabatic OS is a **user-owned, verb-first personal data substrate**. The primitive is the event, not the file: raw events land in an append-only D0 log; docs (D1) and structured tables (D2) are projections that can be re-derived. Every write goes through Guard — the single write boundary that enforces source provenance, permissions, and CDC-style audit into D0. The system is built from native primitives (SQL, files, git, plain TypeScript) because its primary operator is AI, and every invented abstraction is something an AI can mislearn. Long-term purpose: a system that gets more ordered the longer you use it. Current P0: **cold-start a real personal system on the substrate** (see [TODO.md](../TODO.md)).

## Canon (`current/`)

Read these to understand the system as it is designed today. Every doc carries a `Status:` line.

| Doc | One-liner |
|---|---|
| [Verb-First Personal Substrate](current/202605080000-Verb-First%20Personal%20Substrate.md) | The project's self-definition: D0-first, user-owned, re-derivable projections, evolvability contract |
| [Why Now](current/202603050000-Why%20Now%20-%20First%20Principles%20Analysis.md) | Philosophy: No-Abstraction principle, AI economics, Guard rationale, vendor lock-in |
| [Design Pattern: Native Primitives, Guard Boundaries, KISS](current/202605110000-Design%20Pattern%20-%20Native%20Primitives%2C%20Guard%20Boundaries%2C%20KISS.md) | The recurring design bias and when abstraction is justified |
| [D0 D1 Schema Final](current/202602140900-D0%20D1%20Schema%20Final.md) | The one-way-door substrate schema (verified against `core/src/db.ts`) |
| [D0 Source Boundary](current/202605130000-D0%20Source%20Boundary%20-%20Guard%20and%20Connectors.md) | Guard owns *how* events are written; connectors own *why/when/what* |
| [Local Capability Auth](current/202606010000-Local%20Capability%20Auth.md) | Localhost is not a security boundary: core/bridge tokens, query-only reads |
| [Connector Runtime Module](current/202606010100-Connector%20Runtime%20Module.md) | **Active workstream.** Package/integration split, hash trust, capability handles, watch/poll/import |
| [Retrieval Memory Module Requirements](current/202606040000-Retrieval%20Memory%20Module%20Requirements.md) | Requirements only: replaceable retrieval layer, never source of truth |
| [5-Layer Mental Model](current/202602140300-Adiabatic%20OS%20-%205%20Layer%20Mental%20Model.md) | Pages → Apps → Guard → Data → Kernel (canon with caveats — see Status line) |
| [Scope Definition](current/202602140700-Adiabatic%20OS%20-%20Scope%20Definition.md) | Five scopes, uninstall test, one-way vs two-way doors (canon with caveats) |
| [Entropy Engineering](current/202602140600-Entropy%20Engineering%20-%20Objective%20Function%20%26%20Scope.md) | **Parked** long-term purpose: minimize E / maximize U two-layer objective |
| [Design Decisions Log](current/202602140500-Design%20Decisions%20Log.md) | Append-only DD log; see the 20260610 status review for what's alive/dead |

## Other folders

- `process/` — derivations and design discussions; how the canon was reached. Not contracts. Includes open questions (e.g. the unified-entropy-metric doubt, `202604070520-Thought.md`) that must be answered before their parked workstreams restart.
- `archive/` — superseded docs (tombstone header says what replaced them and why), pre-project notes (2025), and use-case candidate notes (health system, time tracking, belief-task alignment) awaiting cold-start use-case selection.

## Lifecycle rule

1. New design doc → `current/` with a `Status:` line (`canon` / `requirements draft` / `parked` / `canon with caveats`).
2. Superseded → `git mv` to `archive/`, prepend a tombstone header (what replaced it, when, why). Don't delete; git is not a reader-facing index.
3. Decisions → dated, append-only entries in the Design Decisions Log. Never rewrite old entries; correct them with a newer dated entry.
4. Backlog lives in [TODO.md](../TODO.md), not in design docs.
