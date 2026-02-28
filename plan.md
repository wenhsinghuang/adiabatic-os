# Adiabatic OS — Full Implementation Plan

從零建立完整 OS runtime：DB + Guard + Working Tree + App Sandbox + MDX Renderer + HTTP Server。

---

## 預期結果

```
adiabatic-os/
├── CLAUDE.md                         ← AI 擴展系統的 conventions
├── package.json
├── tsconfig.json
├── .gitignore
│
├── src/
│   ├── index.ts                      ← Bun HTTP server（進入點）
│   ├── db.ts                         ← LibSQL init，D0 events + D1 docs
│   ├── guard.ts                      ← System API（唯一寫入路徑）
│   ├── working-tree.ts               ← DB ↔ pages/ 雙向 file 同步
│   ├── sandbox.ts                    ← App sandbox（Bun Worker threads）
│   ├── renderer.ts                   ← MDX → React component 編譯
│   ├── app-loader.ts                 ← 掃描 apps/，讀 manifest，註冊 components
│   └── utils/
│       └── ulid.ts                   ← ULID 生成
│
├── test/
│   ├── db.test.ts                    ← Schema 驗證
│   ├── guard.test.ts                 ← Guard + D0 auto-log 核心測試
│   ├── working-tree.test.ts          ← File ↔ DB 同步測試
│   ├── sandbox.test.ts               ← App isolation 測試
│   └── renderer.test.ts              ← MDX compile 測試
│
├── apps/                             ← App 開發區
│   └── hello-world/                  ← 示範 app
│       ├── manifest.json             ← 權限宣告
│       ├── index.tsx                 ← Component + backend
│       └── README.md
│
├── pages/                            ← Working tree（materialized .mdx）
│   └── (auto-generated from DB)
│
├── data/                             ← SQLite DB（gitignore）
└── design/                           ← 現有設計文件（不動）
```

### 做完可以驗證的行為

**Core（DB + Guard）：**
1. `bun run dev` → server 跑在 localhost:3000
2. 每筆 write 自動產生 D0 event — Guard 心臟跳動
3. `bun test` → 全部通過

**Working Tree：**
4. `writeDoc("journal/today", "# Hello")` → `pages/journal/today.mdx` 自動出現
5. 手動改 `pages/journal/today.mdx` → DB 裡 docs 表自動更新
6. `deleteDoc("journal/today")` → file 自動消失

**App Sandbox：**
7. `apps/hello-world/` 有 manifest.json 宣告 write permission
8. App 通過 Worker thread 執行，只能透過 system.* bridge 寫 DB
9. App 嘗試寫未授權的 table → Guard 拒絕

**MDX Renderer：**
10. `docs.content` 裡的 MDX string → 編譯成 React component
11. MDX 裡引用 app component（`<HelloWorld />`）→ 正確 resolve
12. 壞 MDX → 回傳 error 而不是 crash

**HTTP API：**
13. `POST /api/docs` — writeDoc
14. `GET /api/docs/:id` — 讀 doc
15. `DELETE /api/docs/:id` — deleteDoc + D0 快照
16. `POST /api/events` — writeEvent
17. `POST /api/query` — 唯讀 SQL
18. `POST /api/write` — D2 write + D0 log
19. `GET /api/apps` — 列出所有已註冊的 apps
20. `POST /api/render` — MDX string → compiled HTML

---

## 實作步驟

### Step 1: 腳手架 + 依賴
- bun init, package.json, tsconfig.json
- 依賴：mdx-bundler, @mdx-js/mdx, esbuild
- 更新 .gitignore

### Step 2: CLAUDE.md
- 系統 conventions 文件

### Step 3: DB Layer（src/db.ts）
- bun:sqlite 初始化
- D0 events 表 + indexes（一字不改照設計文件）
- D1 docs 表 + indexes（一字不改照設計文件）

### Step 4: ULID（src/utils/ulid.ts）

### Step 5: Guard / System API（src/guard.ts）
- query, write, writeDoc, deleteDoc, writeEvent
- 每個 write method 內部：permission check → 執行 → D0 auto-log
- source 由 Guard 構造時注入，不可偽造

### Step 6: Working Tree（src/working-tree.ts）
- DB → File：Guard writeDoc/deleteDoc 後自動 materialize 到 pages/
- File → DB：fs.watch 偵測 pages/ 變更 → guard.writeDoc()
- 防循環：DB-triggered write 設 flag，file watcher 跳過

### Step 7: App Loader（src/app-loader.ts）
- 掃描 apps/ 目錄
- 讀取每個 app 的 manifest.json
- 建立 component registry（app-id → component list）
- 驗證 manifest 格式

### Step 8: App Sandbox（src/sandbox.ts）
- Bun Worker thread per app
- system.* bridge：Worker 透過 postMessage 呼叫 Guard
- Guard 拿 Worker 對應的 app-id 做 permission check
- 未授權寫入 → reject

### Step 9: MDX Renderer（src/renderer.ts）
- mdx-bundler / @mdx-js/mdx compile MDX string → React component
- Component resolver：MDX 裡的 `<HelloWorld />` → 從 app registry 找到對應 component
- Error handling：compile 失敗回傳 error，不 crash

### Step 10: HTTP Server（src/index.ts）
- Bun.serve，所有 routes
- JSON request/response

### Step 11: 示範 App（apps/hello-world/）
- manifest.json：宣告 app id, name, write permissions
- index.tsx：一個簡單 component + 一個 backend function
- 用來驗證完整 loop

### Step 12: Tests
- db.test.ts, guard.test.ts, working-tree.test.ts, sandbox.test.ts, renderer.test.ts

### Step 13: Git commit + push
