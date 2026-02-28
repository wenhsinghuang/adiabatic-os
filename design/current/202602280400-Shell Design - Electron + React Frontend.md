# 202602280400 Shell Design — Electron + React Frontend

用戶打開 app 看到什麼、怎麼互動、怎麼接上 backend runtime。

---

## 整體架構

```
┌─ Electron ─────────────────────────────────────────────────┐
│                                                             │
│  Main Process (Node.js)                                     │
│  ├─ 啟動 Bun runtime (child process, localhost:3000)        │
│  ├─ 管理 workspace path (~/ Adiabatic/)                     │
│  ├─ First-launch: copy template/ → ~/Adiabatic/            │
│  └─ 視窗管理、menu、系統整合                                  │
│                                                             │
│  Renderer Process (Chromium)                                │
│  ├─ React app                                               │
│  ├─ Sidebar (file tree from pages/)                         │
│  ├─ Editor (BlockNote — unified view/edit)                  │
│  ├─ Source mode (CodeMirror 6 — raw MDX)                    │
│  └─ App components (sandboxed render)                       │
│                                                             │
│         ▲                                                   │
│         │ HTTP (localhost:3000)                              │
│         ▼                                                   │
│  Bun Runtime (child process)                                │
│  ├─ core/src/index.ts (HTTP server)                         │
│  ├─ Guard → DB → Working Tree                              │
│  └─ App Sandbox (Workers)                                   │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

### 為什麼 Bun 是 child process 不是 in-process

- Electron main = Node.js。core runtime = Bun。不同 runtime。
- Child process 乾淨隔離 — Bun crash 不拖垮 Electron。
- 通訊走 HTTP — 已經有 API server，不用額外 IPC protocol。
- 未來 cloud replica 跑同一份 server code，零改動。

---

## 首次啟動

```
1. Electron 啟動
2. 檢查 ~/Adiabatic/ 是否存在
3. 不存在 → copy template/ → ~/Adiabatic/
   ├── CLAUDE.md
   ├── .adiabatic/
   ├── apps/hello-world/
   └── pages/welcome.mdx
4. 啟動 Bun runtime: `bun run core/src/index.ts ~/Adiabatic`
5. 等 server ready (poll localhost:3000)
6. 打開 renderer，載入 welcome page
```

---

## 畫面結構

```
┌──────────────────────────────────────────────────────────┐
│  ← →  Adiabatic                          [view] [source] │
├────────────┬─────────────────────────────────────────────┤
│            │                                             │
│  PAGES     │  ┌─────────────────────────────────────┐   │
│            │  │                                     │   │
│  📄 welcome│  │  # Welcome to Adiabatic             │   │
│  📁 journal│  │                                     │   │
│    📄 today│  │  This is your workspace.            │   │
│  📁 notes  │  │                                     │   │
│            │  │  ## Demo                            │   │
│            │  │  ┌───────────────────────┐          │   │
│            │  │  │ Hello, Adiabatic!     │          │   │
│  ──────────│  │  │ (hello-world app)     │          │   │
│  SYSTEM    │  │  └───────────────────────┘          │   │
│  ⚙ Settings│  │                                     │   │
│  🔌 Connectors│ └─────────────────────────────────────┘   │
│            │                                             │
└────────────┴─────────────────────────────────────────────┘
```

### 三個區域

| 區域 | 內容 | 互動 |
|------|------|------|
| **Top bar** | App name + view/source 切換 | 切換 editor mode |
| **Sidebar** | `pages/` file tree + system views | 點擊開頁面、右鍵 new/delete |
| **Editor** | 當前 page 的 rendered MDX | 點任何地方就能編輯 |

---

## 兩種 Editor Mode

### View Mode（預設）— BlockNote

```
用戶看到的：

  # Weekly Review                       ← 可直接編輯的標題

  This week I focused 32 hours.         ← 可直接編輯的文字

  ┌──────────────────────────────────┐
  │  📊 Focus Chart (this week)       │  ← app component, interactive
  │  ████████ 32h                     │
  └──────────────────────────────────┘

  Notes: feeling productive.           ← 可直接編輯的文字
```

- **Text blocks** — 就是 rich text editor。click 就打字。Notion/Obsidian 體驗。
- **Component blocks** — app component render 在這裡。interactive，可 click、hover。
- **零切換延遲** — 沒有 view/edit toggle。打開就是 live editor。
- 底層是 BlockNote（TipTap/ProseMirror）— Notion-like block editor。

### Source Mode — CodeMirror 6

```
用戶看到的：

  # Weekly Review

  This week I focused 32 hours.

  <FocusChart period="week" />

  Notes: feeling productive.
```

- Raw MDX text。手動調 props、改結構。
- 用 CodeMirror 6 — text-first markdown/JSX editing。
- Power user / debugging 用。

---

## Page Rendering Pipeline

一個 page 從 DB 到畫面的完整流程：

```
1. 用戶點 sidebar「weekly」
   │
2. Renderer: GET /api/docs/weekly
   │  ← { id: "weekly", content: "# Weekly\n<FocusChart />", metadata: {...} }
   │
3. MDX compile (client-side or via POST /api/render)
   │  ← MDX string → React component tree
   │
4. Component resolution
   │  GET /api/apps → 拿到 component registry
   │  "FocusChart" → hello-world app 的 export
   │
5. BlockNote render
   │  text blocks → ProseMirror editable nodes
   │  <FocusChart /> → custom block, render app component inside
   │
6. 用戶看到 rendered page
```

### 編輯 → 存檔

```
1. 用戶在 BlockNote 裡打字 / 改 content
   │
2. Debounced save (300ms idle)
   │
3. Serialize BlockNote → MDX string
   │
4. POST /api/docs { id: "weekly", content: "..." }
   │  ← Guard: upsert docs table + auto D0 log
   │  ← Working Tree: materialize pages/weekly.mdx
   │
5. Done. DB = source of truth, file = synced.
```

---

## Sidebar

### Data Source

```ts
// Sidebar 從兩個來源拿資料：

// 1. Pages — query DB
GET /api/query
{ sql: "SELECT id, metadata FROM docs ORDER BY updated_at DESC" }

// 2. System views — 固定 list
[
  { id: "_settings", label: "Settings", icon: "gear" },
  { id: "_connectors", label: "Connectors", icon: "plug" },
]
```

### 操作

| 動作 | 實作 |
|------|------|
| 開頁面 | click → 載入 doc content → render |
| 新頁面 | right-click → prompt name → POST /api/docs |
| 刪頁面 | right-click → confirm → DELETE /api/docs/:id |
| 重命名 | right-click → prompt → delete old + create new |

### File Tree 結構

Doc IDs 帶路徑語意（`journal/today`、`notes/ideas`），sidebar 自動建 folder 結構：

```
docs in DB:
  journal/today
  journal/yesterday
  notes/ideas
  welcome

sidebar renders as:
  📁 journal
    📄 today
    📄 yesterday
  📁 notes
    📄 ideas
  📄 welcome
```

---

## App Component 在 Page 裡的 Rendering

核心問題：MDX 裡的 `<FocusChart period="week" />` 怎麼變成一個 live component？

### D1 方案：簡單 + 夠用

```
MDX compile 時拿到 component reference
  → 去 app registry 找到對應 app
  → dynamic import app 的 bundled component
  → render 在 BlockNote 的 custom block 裡
```

**限制：** app component 跟 main renderer 同進程。沒有 sandbox isolation。
**為什麼 OK：** D1 scope — single user，app code 是用戶自己（或 AI）寫的。Crash = 該 component 顯示 error boundary，不影響其他。

### 未來（WebContainers）

```
每個 app component 跑在獨立 WebContainer (WASM sandbox)
  → iframe-like isolation
  → postMessage bridge for system.* calls
  → crash / leak 完全隔離
```

等有 marketplace / 3rd-party apps 時再升級。

---

## 錯誤處理

| 情境 | 行為 |
|------|------|
| MDX compile 失敗 | Editor 顯示 error banner，保留 raw content 可編輯 |
| App component crash | React Error Boundary catch，顯示 placeholder，其他 block 不受影響 |
| Server 斷線 | 顯示 offline indicator，queue 寫入，reconnect 後 flush |
| Component not found | 顯示 `<Missing: FocusChart />` placeholder |

---

## Tech Stack

| 層 | 選擇 | 理由 |
|---|---|---|
| Desktop shell | Electron | SharedArrayBuffer 原生支援、生態最大 |
| UI framework | React | AI 最熟、MDX 原生生態 |
| Block editor | BlockNote | Notion-like UX、建在 TipTap/ProseMirror、原生 Yjs |
| Source editor | CodeMirror 6 | Text-first markdown editing |
| MDX compiler | @mdx-js/mdx | 已在 core 裡 |
| Build | Vite | Dev server + HMR |
| IPC | HTTP (localhost:3000) | 已有 API，不用額外 protocol |

---

## 開發 repo 結構

```
adiabatic-os/
├── core/              ← runtime (已完成)
├── shell/             ← Electron app (要蓋)
│   ├── package.json
│   ├── electron/
│   │   └── main.ts    ← Electron main process
│   └── src/
│       ├── App.tsx            ← root React component
│       ├── components/
│       │   ├── Sidebar.tsx    ← file tree + system views
│       │   ├── Editor.tsx     ← BlockNote view mode
│       │   ├── SourceEditor.tsx ← CodeMirror 6 source mode
│       │   ├── TopBar.tsx     ← navigation + mode switch
│       │   └── AppBlock.tsx   ← custom block for app components
│       ├── hooks/
│       │   ├── useDoc.ts      ← fetch + save doc via API
│       │   └── useDocs.ts     ← list all docs for sidebar
│       └── lib/
│           └── api.ts         ← HTTP client for localhost:3000
├── template/          ← user workspace template (已完成)
└── design/            ← design docs
```

---

## Open Questions

1. **MDX compile 在哪裡做？** Client-side（renderer process）還是 server-side（POST /api/render）？
   - Client-side：更快的反饋 loop，不走 HTTP。
   - Server-side：renderer 不需要裝 MDX compiler。
   - **傾向 client-side** — editor 需要即時 preview。

2. **BlockNote custom block API** — 需要確認 BlockNote 是否支援在 block 裡 render arbitrary React component。如果不支援，可能需要用 TipTap NodeView 直接做。

3. **Auto-save 策略** — debounce 300ms？還是 explicit save（Cmd+S）？
   - **傾向 auto-save** — 像 Notion/Obsidian。打完字自動存。

4. **Sidebar refresh** — poll、WebSocket、還是 event listener？
   - **傾向 poll** — D1 simplest。每 2s query docs list。未來加 WebSocket。
