# Adiabatic OS — Workspace Conventions

This workspace is managed by Adiabatic OS. Follow these conventions when writing code.

## Workspace Structure

```
├── CLAUDE.md          ← you are here
├── .adiabatic/        ← runtime data (DB lives here, do not modify directly)
├── apps/              ← sandboxed apps (you write code here)
│   └── <app-name>/
│       ├── manifest.json
│       └── index.tsx
└── pages/             ← working tree (.mdx files, synced with DB)
```

## Writing an App

Every app lives in `apps/<app-name>/` with two required files:

### manifest.json

```json
{
  "id": "my-app",
  "name": "My App",
  "permissions": {
    "write": ["my_table"]
  }
}
```

- `id`: unique identifier, must match directory name
- `permissions.write`: D2 tables this app can write to. All apps can read all data.

### index.tsx

```tsx
import type { System } from "@adiabatic/core";

// UI component — rendered inside MDX pages
export function MyWidget({ period }: { period: string }) {
  return <div>Hello from MyWidget</div>;
}

// Backend function — runs in sandbox, receives system API
export async function onSchedule(system: System) {
  const rows = await system.query("SELECT * FROM my_table");
  await system.write("INSERT INTO my_table (id, value) VALUES (?, ?)", [id, value]);
}
```

## System API

Apps interact with data exclusively through the System API:

```ts
system.query(sql, params?)          // Read any table (D0, D1, D2)
system.write(sql, params?)          // Write to permitted D2 tables (auto D0 log)
system.writeDoc(id, content, meta?) // Upsert D1 doc (auto D0 log)
system.deleteDoc(id)                // Delete D1 doc (auto D0 log, snapshot saved)
system.writeEvent(event)            // Write D0 event directly
```

**Rules:**
- All writes go through Guard — permission checked against manifest
- Every write automatically produces a D0 event (audit trail)
- Apps have universal read, scoped write
- Never write to `.adiabatic/` or DB files directly

## Pages (MDX)

Pages in `pages/` are MDX files synced with the DB. They can embed app components:

```mdx
# My Dashboard

Some text here...

<MyWidget period="week" />
```

- DB is source of truth; `pages/` is a convenience layer
- Editing a `.mdx` file auto-syncs to DB
- Writing a doc via API auto-materializes to `pages/`

## Data Layers

| Layer | Table | Purpose |
|-------|-------|---------|
| D0 | `events` | Append-only audit trail. Every write is logged here. |
| D1 | `docs` | MDX content. User's pages and notes. |
| D2 | app tables | Structured data. Created via `system.promote()`. |
