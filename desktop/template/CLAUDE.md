<!-- ADIABATIC:SYSTEM:START -->
# Adiabatic OS — Workspace Conventions

This workspace is managed by Adiabatic OS. Follow these conventions when writing code.

## Workspace Structure

```
├── CLAUDE.md
├── apps/
│   └── <app-id>/
│       ├── .git/
│       ├── manifest.json
│       ├── package.json
│       └── index.tsx
└── pages/
    └── *.mdx
```

## Default Workflow

- Edit pages directly in `pages/*.mdx`.
- Edit app code only inside `apps/<app-id>/`.
- Use `@adiabatic/system` for data reads and writes.
- Use `adiabatic query "<sql>"` to inspect data.
- Use `adiabatic promote "<ddl>"` or `adiabatic demote "<ddl>"` for schema changes.
- Do not inspect or modify runtime-managed files.

## App Shape

`manifest.json` declares write grants:

```json
{
  "id": "my-app",
  "name": "My App",
  "permissions": {
    "write": ["my_table"]
  }
}
```

`index.tsx` is an ordinary React app:

```tsx
import * as React from "react";
import { system } from "@adiabatic/system";

export default function App() {
  const [rows, setRows] = React.useState<unknown[]>([]);

  async function refresh() {
    const result = await system.query("SELECT * FROM my_table LIMIT 20");
    setRows(result.rows);
  }

  return <button onClick={refresh}>Refresh</button>;
}
```

## System API

```ts
system.query(sql, params?)          // Read data
system.write(sql, params?)          // INSERT/UPDATE/DELETE permitted D2 tables
system.writeDoc(id, content, meta?) // Upsert D1 doc
system.deleteDoc(id)                // Delete D1 doc
system.writeEvent(event)            // Write D0 event; source is injected by runtime
```

Rules:

- Do not pass `source`; Guard injects it from runtime identity.
- `system.write` accepts one DML statement: `INSERT`, `UPDATE`, or `DELETE`.
- Schema changes are raw DDL, but must go through `promote` / `demote`.
- Apps can read globally but can only write tables listed in `manifest.json`.
- D0 events are append-only. Do not try to update or delete them.

## Layers

| Layer | Purpose |
|-------|---------|
| D0 | Raw append-only event log and audit trail. |
| D1 | `pages/*.mdx` working tree mirror. |
| D2 | Derived/read-model tables owned by app/schema lifecycle. |
<!-- ADIABATIC:SYSTEM:END -->
