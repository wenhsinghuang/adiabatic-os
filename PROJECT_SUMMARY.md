# Adiabatic OS — 專案目的與架構總覽

## 一句話定義

Adiabatic OS 是一個**個人系統運行環境**，核心理念是：你的系統應該**越用越好**，而不是越用越亂。

---

## 為什麼要做這個？

### 現有工具的根本問題：熵陷阱 (Entropy Trap)

你的 Notion 筆記用越久越亂、檔案系統慢慢變成垃圾場、資料散落在 N 個工具裡。現有工具只提供「存放空間」，不會主動幫你整理。

**Adiabatic 反轉這個趨勢**：系統內建 Optimizer，持續分析並降低資料的混亂度（熵），讓系統隨使用時間自動變得更有組織。

### 三條永恆原則

1. **Data beats Code** — 資料是資產，程式碼是負債，畫面是短暫的
2. **維護成本隨時間遞減** — AI 吸收整理工作，人只負責輸入
3. **結構從使用中自然生長** — 不預設 schema，讓重複出現的概念自然結晶為結構

---

## 五層架構

```
┌───────────────────────────────────────────────────────┐
│  Pages (MDX)                         ← 檢視層         │
│  可嵌入任何 App 元件，本身可拋棄                        │
├───────────────────────────────────────────────────────┤
│  Apps (Sandboxed)                    ← 邊界層         │
│  每個 App 有 manifest.json 宣告權限                    │
│  含 components / crons / backend logic                │
├───────────────────────────────────────────────────────┤
│  Guard (Enforcement)                 ← 執行層         │
│  唯一寫入路徑・權限檢查・每次寫入自動產生 D0 稽核紀錄    │
├───────────────────────────────────────────────────────┤
│  Data Layer (SQLite)                 ← 資料層（資產）  │
│  D0: events (唯加) ─ D1: docs (MDX) ─ D2: tables     │
├───────────────────────────────────────────────────────┤
│  @adiabatic/core                     ← OS 核心        │
│  Guard · DB · Server · WorkingTree · AppLoader        │
└───────────────────────────────────────────────────────┘
```

**一句話讀法：** Pages 組合 Apps → Apps 通過 Guard → Guard 保護 Data → Data 坐在 OS 上。

---

## 三層資料模型 (D0 / D1 / D2)

這是整個系統的「不可逆決策」——schema 一旦定下，改動需要遷移。

### D0: Events — 系統記憶（唯加、不可刪除）

**回答的問題：** 發生了什麼事？

```sql
CREATE TABLE events (
  id          TEXT PRIMARY KEY,    -- ULID（可依時間排序）
  source      TEXT NOT NULL,       -- "app:focus-tracker" 或 "connector:oura"
  type        TEXT NOT NULL,       -- "sleep.recorded", "d1.write", "d2.insert"
  external_id TEXT,                -- 外部系統去重 key
  started_at  INTEGER NOT NULL,    -- 事件實際發生時間
  ended_at    INTEGER,             -- 持續性事件的結束時間
  payload     JSON NOT NULL,       -- 自由格式資料
  created_at  INTEGER NOT NULL     -- 寫入系統的時間
);
```

- 所有經 Guard 的寫入都自動產生 D0 事件（完整稽核軌跡）
- 永不刪除；未來的 LLM 可以用更好的模型重新分析原始資料

### D1: Docs — 活文件（MDX 格式）

**回答的問題：** 你寫了什麼/想了什麼？

```sql
CREATE TABLE docs (
  id          TEXT PRIMARY KEY,    -- 語義化："journal/20250214" 或純 ULID
  content     TEXT NOT NULL,       -- 原始 MDX 字串
  metadata    JSON,                -- 標籤、鎖定、文件類型等
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);
```

- 可以硬刪（D0 有完整編輯歷史）
- Working Tree 模式：DB 是真相來源，`pages/` 目錄是 .mdx 檔案的實體化

### D2: Structured Tables — 結構化知識

**回答的問題：** 什麼模式結晶了？

- 由 App 透過 `system.promote()` 動態建立
- 全域可讀、寫入需權限
- 概念從 D1（混亂）晉升至 D2（乾淨），反之亦然

### 資料沉積路徑

```
D0: 原始事件     （高熵、雜訊）
  ↓ adapter / LLM pipeline
D1: 活文件       （語義清晰、人工策展）
  ↓ promote（跨場景模式 + 重複使用 = 穩定概念）
D2: SQL 表格     （低熵、可查詢、AI 友善）
  ↓ demote（結構不再使用時降級回 D1）
```

---

## Guard：唯一寫入路徑

所有資料庫變動都必須經過 Guard，App 永遠不能直接寫入。

### System API

```typescript
system.query(sql, params)            // 讀取 D0/D1/D2（無權限檢查、無 D0 紀錄）
system.write(sql, params)            // D2 DML（權限檢查 → 執行 → 自動 D0 紀錄）
system.writeDoc(id, content, meta)   // D1 upsert（自動 D0 紀錄 + Working Tree 同步）
system.deleteDoc(id)                 // D1 硬刪（快照存入 D0 + 刪除檔案）
system.writeEvent(event)             // D0 明確寫入（Connector 使用）
system.promote(config)               // DDL：建立 D2 表格（自動 D0 紀錄）
system.demote(table)                 // DDL：封存 D2 表格（自動 D0 紀錄）
```

### 權限模型

- **Source 注入**：Guard 建構時綁定 source，App 無法偽造身份
- **Manifest 宣告**：App 在 `manifest.json` 中宣告可寫入的表格
- **全域可讀**：所有 App 都能 SELECT 任何表格
- **範圍寫入**：App 只能寫入被授權的表格

### 自動 D0 紀錄對照表

| 操作 | D0 Type | Payload |
|------|---------|---------|
| INSERT D2 | `d2.insert` | `{table, row}` |
| UPDATE D2 | `d2.update` | `{table, row}` |
| DELETE D2 | `d2.delete` | `{table, row}`（刪除前的值） |
| writeDoc | `d1.write` | `{doc_id, bytes}`（行為訊號） |
| deleteDoc | `d1.delete` | `{doc_id, content, metadata}`（完整快照） |
| promote | `ddl.promote` | `{table, columns}` |
| demote | `ddl.demote` | `{table}` |

---

## 熵工程：系統的目標函數

### 核心目標

```
minimize E（結構熵 + 語義熵 + 互動熵）
約束條件：Optimizer 不能刪除資料，只能重組/晉升/合併/重構
```

### 三種熵維度

| 類型 | 定義 | 症狀 | 降低策略 |
|------|------|------|----------|
| **結構熵** | 資料散布在太多地方 | 理解一個概念需要查 10 張表 | 合併表格、晉升 schema |
| **語義熵** | 含義不清晰 | AI 無法理解欄位名稱 | 釐清命名、常數晉升為 schema |
| **互動熵** | 完成任務的摩擦力高 | 記錄一次專注要 20 步 | 工作流、預設值、批次操作 |

### 系統演化循環

```
使用者使用系統 → 資料累積（D0/D1/D2 成長）
       ↓
Optimizer（背景執行）：透過重組/晉升/合併來 minimize E
       ↓
Utility Intelligence App：讀取已組織的資料 → 產生洞見
       ↓
使用者審閱建議 → 決定採納
       ↓
系統自然演化
```

---

## 技術棧

| 層級 | 選擇 | 原因 | 可替換？ |
|------|------|------|----------|
| Runtime | Bun | 原生 SQLite、TypeScript-first、Worker threads | 是 |
| Database | SQLite (WAL) | 嵌入式、最普及的 DB 格式、離線優先 | 是（需遷移） |
| Desktop Shell | Electron 33 | SharedArrayBuffer (WebContainers)、Chromium 一致性 | 可能 |
| UI Framework | React 19 | AI 工具最熟悉、MDX 生態系原生支援 | 是 |
| Editor | BlockNote | Notion 風格 UX、TipTap/ProseMirror 基底、原生 Yjs 支援 | 是 |
| MDX Compiler | @mdx-js/mdx | JS 生態系標準 | 是 |
| App Sandbox | WebContainer API | WASM 隔離、可升級 | 是 |
| Build Tool | Vite 6 | Dev server + production build | 是 |

---

## 雙副本部署模型

相同的 runtime 程式碼跑在兩個地方：

### Desktop（Electron）

```
Electron Main → 管理 workspace、首次啟動複製 template
Bun Runtime (localhost:3000) → Guard + DB + API + App Sandbox + Working Tree
Chromium Renderer → React UI + BlockNote editor + MDX render
```

用於：電腦開著的時候（離線優先、完整功能）

### Cloud（Fly.io）

```
Container → 相同的 Bun Runtime
常駐 crons + Connector 同步 + 背景 ETL + Sync endpoint
Turso (Managed SQLite) + Litestream → R2 備份
```

用於：電腦關著的時候（自動化、同步、備份）

Desktop 不是 thin client，Cloud 不是 server——兩者都是完整的 runtime 實例。

---

## Working Tree：DB ↔ 檔案雙向同步

**問題：** AI 工具（Claude Code、Cursor）自然地讀寫 .mdx 檔案，但 D1 住在 DB 裡。

**解法：** Working Tree 將 D1 實體化為 `pages/` 目錄下的 .mdx 檔案。

```
DB（真相來源）
  ↓ Guard.writeDoc()
  → 實體化為 pages/doc-id.mdx

pages/doc-id.mdx（使用者/AI 編輯）
  ↓ fs.watch 偵測變更
  → syncFileToDb() → guard.writeDoc()（帶防迴圈旗標）
  → 回到 DB
```

**防迴圈機制：** DB 觸發的檔案寫入會在 `dbTriggered` Set 中設旗標，file watcher 跳過被標記的路徑，100ms 後清除。

---

## App 模型

### 結構

```
apps/
└── focus-tracker/
    ├── manifest.json     ← 權限 + 元資料
    └── index.tsx         ← React 元件 + 後端邏輯
```

### manifest.json

```json
{
  "id": "focus-tracker",
  "name": "Focus Tracker",
  "permissions": {
    "write": ["focus_sessions"]
  },
  "components": ["FocusChart", "FocusStats"]
}
```

### index.tsx

```tsx
// UI 元件（在 MDX 頁面中渲染）
export function FocusChart({ period }) {
  const data = system.query("SELECT * FROM focus_sessions WHERE ...");
  return <Chart data={data} />;
}

// 後端函式（以 cron/task 執行）
export async function summarizeFocus(system) {
  const rows = system.query("SELECT * FROM focus_sessions WHERE ...");
  system.write("INSERT INTO focus_summaries VALUES (?, ?)", [id, summary]);
}
```

### 設計哲學

- **程式碼可拋棄** — App 的 bug 不會損害資料
- **資料是永久的** — D0 有完整編輯歷史
- **Manifest 有約束力** — 權限合約由 Guard 強制執行
- **Pages 自由組合** — 任何頁面可以引用任何 App 的元件

---

## 專案目錄結構

```
adiabatic-os/                        （開發用 repo）
├── core/                            @adiabatic/core runtime
│   ├── src/
│   │   ├── index.ts                 Bun HTTP server 進入點
│   │   ├── db.ts                    SQLite schema 初始化（D0 + D1）
│   │   ├── guard.ts                 權限檢查 + D0 自動紀錄
│   │   ├── types.ts                 共用型別定義
│   │   ├── working-tree.ts          DB ↔ 檔案雙向同步
│   │   ├── app-loader.ts            掃描 apps/、建立 registry
│   │   ├── renderer.ts              MDX → React 編譯
│   │   └── utils/ulid.ts            ULID 產生器
│   └── test/                        各模組測試
│
├── shell/                           Electron 前端
│   ├── electron/main.ts             Electron 生命週期管理
│   └── src/
│       ├── App.tsx                   根佈局 + sandbox 初始化
│       ├── components/              TopBar, Sidebar
│       ├── editor/                  PageView, BlockNote, MDX source editor
│       ├── sandbox/                 WebContainer 生命週期 + system bridge
│       ├── renderer/                MDX → React 渲染 + 元件 registry
│       ├── hooks/                   useDoc, useDocs
│       └── lib/api.ts               HTTP client → core server
│
├── template/                        使用者 workspace 種子
│   ├── CLAUDE.md                    AI 工具慣例 + System API 規格
│   ├── apps/hello-world/            範例 App
│   └── pages/welcome.mdx            起始頁面
│
└── design/                          設計文件（不隨產品發佈）
    ├── current/                     最新規格
    ├── process/                     設計過程紀錄
    └── archive/                     舊版迭代
```

---

## Adiabatic OS 的獨特之處

1. **雙副本架構** — 相同 runtime 跑在兩處（Desktop + Cloud），不是 client-server
2. **熵作為一級目標** — 主動降低混亂度，不只儲存資料
3. **D0/D1/D2 三層資料模型** — 清晰分離：原始訊號、人類思維、結構化知識
4. **Working Tree 模式** — DB 為真相、檔案為介面（橋接 SQL 查詢性與 AI 工具友善性）
5. **Guard 單一執行點** — 每次寫入都經過同一個地方（完美稽核軌跡）
6. **「一切皆為檢視」** — Pages、docs、components 都是底層資料的投影；刪除檢視，資料仍在
7. **System API 而非 SDK** — App 透過 system bridge 呼叫（sandbox 安全、權限檢查、D0 紀錄）
8. **可攜式 runtime** — 使用者擁有完整基礎設施，匯出開放格式（SQLite + MDX）
