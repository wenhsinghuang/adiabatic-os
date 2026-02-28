# 202602141000 Tech Stack & Architecture

Tech stack 全部是 two-way door — 不影響 D0/D1 schema。任何一項都能換。

---

## Architecture

```
┌─ Desktop (Electron) ──────────────────────────────┐
│                                                     │
│  React + BlockNote/CM6 + mdx-bundler                │
│                                                     │
│  App Sandbox (WebContainers)                        │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐            │
│  │ App A    │ │ App B    │ │ App C    │            │
│  │ (WASM)   │ │ (WASM)   │ │ (WASM)   │            │
│  └────┬─────┘ └────┬─────┘ └────┬─────┘            │
│       └────────────┼────────────┘                   │
│                    │ postMessage (system.* bridge)   │
│                    ▼                                │
│  Bun runtime (main process)                         │
│    ├─ System API (Guard)                            │
│    ├─ File watcher (working tree ↔ DB)              │
│    └─ LibSQL embedded replica                       │
│                                                     │
└────────────────────┬────────────────────────────────┘
                     │ sync (LibSQL replication + Yjs)
┌────────────────────▼────────────────────────────────┐
│  Cloud (Fly.io)                                      │
│                                                      │
│  Bun runtime (same code)                             │
│    ├─ System API (Guard)                             │
│    ├─ Optimizer (LLM via Vercel AI SDK)              │
│    ├─ Connectors (cron, external APIs)               │
│    ├─ Turso LibSQL primary                           │
│    └─ Litestream → R2 backup                         │
│                                                      │
└──────────────────────────────────────────────────────┘
```

### Twin-Replica 模型

Desktop 和 Cloud 跑同一份 runtime。不是 client-server — 是兩個對等 instance。

- **Desktop**：主要使用環境。有 UI、editor、file system。離線可用。
- **Cloud**：always-on。跑 Optimizer、Connector cron、sync endpoint。
- **Sync**：LibSQL embedded replica（DB 層）+ Yjs（D1 docs CRDT）。

寫入流向：Desktop write → Turso primary (cloud) → sync 回 desktop。離線時 local queue，上線後 flush。

### Data Flow

```
用戶操作 / App / Connector
         │
         ▼
   System API (Guard)
    ├─ permission check（manifest）
    ├─ 執行寫入
    └─ auto D0 log
         │
         ▼
   LibSQL (.db)
    ├─ events (D0)
    ├─ docs (D1)
    └─ app tables (D2)
```

所有寫入經過 System API → 自動產生 D0 event → Optimizer 有原料分析。

### Page Rendering

```
docs.content (MDX text, 在 DB)
    │
    │  載入時 compile 一次
    ▼
mdx-bundler → React component
    │
    ▼
BlockNote document model (runtime)
    ├─ text blocks → 可讀可寫（click 就能打字）
    └─ component blocks → WebContainer 裡的 app component
                              │
                              └─ 透過 system.* bridge query 資料
```

View mode 和 edit mode 是同一個東西 — BlockNote 同時是 renderer 和 editor。
Source mode 切到 CM6 text editor，看 raw MDX。

---

## App Sandbox — WebContainers

每個 app 跑在自己的 WebContainer instance 裡（WASM-sandboxed Node.js）。

### 為什麼選 WebContainers

- **True isolation** — WASM sandbox，不是 JS-in-JS。crash、infinite loop、memory leak 出不去。
- **統一模型** — app 的 component render + logic + cron 全在同一個 sandbox 裡。不分 frontend/backend。
- **開發者無感** — 寫一個 module，OS 透明放進 WebContainer。開發者不知道 sandbox 存在。
- **完整 Node.js** — app 可以用 npm packages。
- **已驗證** — Bolt.new / StackBlitz production 在用。

### 設計

```
開發者寫的：

  // apps/focus-tracker/index.ts
  export const manifest = { write: ['focus_sessions'] }

  export function FocusChart({ period }) {
    const data = useQuery('SELECT ...')
    return <Chart data={data} />
  }

  export function hourlySummary(system) {
    await system.query('...')
    await system.write('...')
  }
```

```
OS 做的：

  App source
    │
    │  esbuild per-app（compile isolation）
    ▼
  App bundle
    │
    │  載入到獨立 WebContainer（runtime isolation）
    ▼
  ┌─ WebContainer (WASM sandbox) ────────────────┐
  │                                                │
  │  App 全部 code 跑在這裡                         │
  │  ├─ FocusChart render → 輸出 UI 到 page        │
  │  ├─ hourlySummary → 背景執行                    │
  │  └─ system.* bridge → postMessage → Guard      │
  │                                                │
  │  crash / infinite loop / leak 出不去            │
  │                                                │
  └────────────────────────────────────────────────┘
```

### Inter-app 通訊

不需要。Apps 之間唯一的交集是 data layer（D2 tables）。

- App A 寫 `focus_sessions` table
- App B 讀 `focus_sessions` table（universal read）
- 沒有 shared memory、沒有 shared code、沒有 import

如果兩個 app 需要直接通訊 → 合併成一個 app，或共用一張 D2 table。

### 為什麼用 Electron 不用 Tauri

WebContainers 需要 SharedArrayBuffer。Electron（Chromium）原生支援。Tauri（macOS WebKit）支援不確定。為了確保 WebContainers 穩定運行，選 Electron。

---

## Tech Stack

### Runtime & Backend

| 選擇 | 為什麼 |
|------|--------|
| **Bun** | 原生 SQLite binding（`bun:sqlite`）、TypeScript first-class、Worker threads、快 |

### Database & Sync

| 選擇 | 為什麼 |
|------|--------|
| **Turso / LibSQL** | SQLite 相容、embedded replica sync、managed service |
| **Yjs** | D1 docs 的 CRDT sync、TipTap/BlockNote 原生整合 |
| **sqlite-vec** | Vector search 留在同一個 DB，不引入外部 service |

Sync 策略：LibSQL replication 處理 DB 層同步，Yjs 處理 D1 doc 的 CRDT merge。

### Desktop Shell

| 選擇 | 為什麼 |
|------|--------|
| **Electron** | 最成熟的 desktop shell、Chromium 跨平台一致、SharedArrayBuffer 原生支援（WebContainers 需要）、生態最大、AI 最熟 |

### UI & Editor

| 選擇 | 為什麼 |
|------|--------|
| **React** | AI 工具最熟、MDX 原生生態、app 開發者最可能會 |
| **BlockNote** | Notion-like UX 開箱即用、建在 TipTap/ProseMirror 上、原生 Yjs 整合 |
| **CodeMirror 6** | Source mode 用。text-first markdown 編輯 |
| **mdx-bundler** | MDX string → React component。接 docs.content → render |

Editor = renderer。用戶打開 page 就能看、能互動、能打字。沒有 view/edit mode 切換延遲。

### MDX 作為 Page 格式

MDX = Markdown + JSX。選它的理由：

- 不用 component 時 = 純 markdown，零學習成本
- 需要 component 時 = AI 寫 JSX（`<FocusChart period="week" />`）
- Human-readable — working tree 的 `.mdx` files 可用任何 text editor 開
- SQL queryable — `docs.content` 是 TEXT，可 grep
- React 生態原生支援

用戶不需要知道 MDX 的存在。Block editor 抽象掉語法，AI 處理 component embedding。

### App Sandbox

| 選擇 | 為什麼 |
|------|--------|
| **WebContainers** | WASM sandbox、per-app isolation、統一模型（不分 frontend/backend）、開發者無感、已被 Bolt.new/StackBlitz 驗證 |

Marketplace app 和用戶自己 vibe code 的 app 都需要 isolation。WebContainers 提供 WASM-level 隔離 — 一個 app crash 不影響其他 app 和 OS。

### LLM

| 選擇 | 為什麼 |
|------|--------|
| **Vercel AI SDK** | Provider-agnostic（Claude、OpenAI、Ollama 都支援） |
| **Claude API（default）** | Optimizer 需要強推理能力 |

未來可加 local model（Ollama）做離線 / privacy 場景。

### Build

| 選擇 | 用途 |
|------|------|
| **Vite** | Dev server + HMR |
| **esbuild** | Per-app production bundle（一個 app build 失敗不影響其他） |

### Backup

| 選擇 | 用途 |
|------|------|
| **Litestream** | SQLite continuous replication |
| **Cloudflare R2** | Object storage for backup |

---

## 需求矩陣

| 功能 | Desktop | Cloud |
|------|---------|-------|
| SQLite / LibSQL | ✓ | ✓ |
| System API runtime | ✓ | ✓ |
| App sandbox (WebContainers) | ✓ | ✓ |
| UI render | ✓ | ✗ |
| MDX editor | ✓ | ✗ |
| File watcher | ✓ | ✗ |
| Native 視窗 | ✓ | ✗ |
| Always-on cron | ✗ | ✓ |
| Sync endpoint | ✗ | ✓ |
| Backup | ✗ | ✓ |
| LLM API | △ | ✓ |
