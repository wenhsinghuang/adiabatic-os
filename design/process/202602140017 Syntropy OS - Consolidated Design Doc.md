# 202602140017 Syntropy OS — Consolidated Design Doc

Compiled from 11 design notes (Aug–Nov 2025) + architecture review sessions (Feb 2026).

---

## 1. Philosophy (不變的核心)

> **你的系統用越久應該越好用，不是越難用。**

三個永恆原則：

1. **Data 比 Code 活得久** — Data is the Asset. Code is the Liability. Views are Ephemeral.
2. **維護成本隨時間下降** — AI 吸收整理負擔，人類只負責輸入。
3. **結構從使用中生長** — 不預先規定 schema，讓反覆出現的概念自然沈澱成結構。

### Everything is a View (20260214)

> **「Views are Ephemeral」的完整實現。**

MDX 統一了 doc 和 frontend — 一個 page 就是一份 MDX，差別只在 text 跟 component 的比例：

```
純 doc（100% text）   ←── spectrum ──→   純 app（100% component）
  Journal                Weekly Review            Tasks
  全文字                  文字 + 圖表             <TaskApp />
```

設計原則：
- **Page = View**：所有用戶看到的頁面都是 D0/D1/D2 上面的投影
- **刪 page ≠ 刪 data**：data 住在 D0/D1/D2，page 只是看 data 的窗口
- **同一份 data，無限 view**：可以用不同 page/component 看同一筆 D2 data
- **View 可拋可重建**：Claude Code 砍掉 UI 重寫 → 零資料損失

注意：D1 doc content 同時是 data（存在 docs table）也透過 page render 呈現。Page 是 D1 content 的 view + edit 入口，但 content 本身在 D1 layer 持久存在。

**跟 Notion 的差異：** Notion 也說「everything is a page」，但 Notion 的 page IS data（耦合）— 刪 page 就丟 data，view 類型限定 5 種，data 鎖在私有 block model。Syntropy 的 page 是 data 的投影（分離）— 刪 page data 還在，view 類型無限（任何 React component），data 是開放格式（SQLite + MDX）。Notion 有類似的哲學直覺，但作為上一代產品，view 和 data 的耦合是根本限制。

**但 MDX 統一的只是 view layer。** App 不只是 frontend — 用戶的 personal system 可以有自己的 backend logic（cron jobs, API routes, ETL pipelines, automations）。這些 backend 邏輯住在 codebase 裡，由用戶通過 Claude Code 開發和維護。Syntropy 是 OS，用戶在上面 build 完整的 full-stack applications。（詳見 §6 演化段落）

### 我們不做的事

- 不做更好的 Notion（Block-based storage 是錯的）
- 不做更好的 Heptabase（Spatial coordinates 作為 data 是污染）
- 不做 n8n-style workflow（結構熵拆給 plugin 是災難）
- 不把 view 資訊混進 storage format

### 核心信念

- 人類腦容量有限（7±2 個概念），任何需要手動維護的大系統長期都會崩潰
- 資料量一定會爆炸，只能靠「沈澱策略」取勝，不能靠「整理」取勝
- 系統必須是可遷移、可重建的資產
- AI 的上下文是昂貴的，高密度語言（SQL + 簡潔 schema）優於散落的 adapter code

---

## 2. Problem Definition

### 核心問題

不是「如何做更好的筆記工具」，而是 **「如何讓個人知識系統永續」**。

### Productivity tool 的三個本質問題

1. **P1: 不可能完美滿足 personalized 需求** — 個體認知模式 vs 標準化軟體的根本矛盾
2. **P2: Vendor lock-in 極度嚴重** — 累積的 data 綁死在特定 app 的特定 data model
3. **P3: Data 散落各處** — 生活/工作資訊分散在 N 個不同工具裡

### Entropy 三分類

| 類型 | 定義 | 症狀 | 控制手段 |
|------|------|------|---------|
| **語意熵** | 資料「到底在說什麼」的不確定度 | AI 聽不懂你、欄位語意不清 | 命名、型別、promote 成 schema |
| **結構熵** | 系統結構有多碎、多難 trace | 追一個 task 要看十個地方 | merge table、migration、刪過時 app |
| **交互熵** | 人跟系統互動的心智負擔 | 懶得用、每次操作都要想 | 預設值、一鍵動作、Context Layer |

管理原則：**用結構熵換語意熵** — 允許 schema 多一點，但換來概念清楚 + AI 好用。

### Entropy 動態管理：Promote / De-promote / Merge

整體機制是一個持續的動態平衡：

- **Promote**：常用的概念 → 沈澱成 D2 schema → 結構熵微升，語意熵+交互熵大降
- **De-promote**：沒用的結構 → 溶回語意土壤 → 回收結構熵，raw data 保留在 D0/D1
- **Merge**：重複的結構 → 合併 → 三種熵同時降（最賺的操作）

Promote 的唯一正當理由：「這個結構能大幅降低語意熵或交互熵，並經常被使用。」

信號：跨 context 出現 + 多次被引用 = 穩定概念，值得付出結構成本。

### Entropy 量化方向 (Draft — 待完善)

> Status: 早期構想，方向對但具體方法還有很多 room to improve。

#### 理論基礎

Syntropy 的 entropy 本質上是 **Shannon information entropy 的 domain-specific application** — 測量「在個人系統中找到和理解資訊的不確定性」。

Shannon Entropy: `H(X) = -Σ p(xᵢ) log₂ p(xᵢ)`

白話：你在收到答案之前，平均有多驚訝。確定的事 = 0 entropy，完全隨機 = 最大 entropy。

三種 entropy 的 Shannon 解讀：
- **Semantic H = H(Meaning | Data)** — 看到這筆資料，對它意思的不確定度
- **Structural H = H(Location | Concept)** — 知道想找什麼，但不確定在哪
- **Interaction H = H(Action | Intent)** — 知道想做什麼，但不確定怎麼做

#### 量化 Proxy（初步構想）

**Semantic H → Vector Embedding Similarity**

核心思路：embed 所有 schema/data 裡的名稱和值，找 cosine similarity 高但文字不同的 pair = 同一概念的不同表達。

計算層級（由易到難）：
1. D2 schema level — column/table names 的歧義
2. D2 data level — 欄位值的不一致（`"done"` vs `"completed"`）
3. D1 ↔ D2 cross-layer — doc 用詞跟 schema 命名不一致（promote/de-promote 信號）
4. D1 content level — doc 內自然語言的概念歧義

```
semantic_H(concept) ≈ log₂(同一語意 cluster 中的不同表達數量)
```

Cross-layer 特別有價值：
- D1 高頻出現 + D2 沒有 → **promote signal**
- D2 存在 + D1 從不提到 → **de-promote signal**

**Structural H → Schema 分析**

```
structural_H(concept) ≈ log₂(該概念的資訊分散在幾張 table)
```

也可用 vector similarity：找所有 column/table name 跟目標概念 embedding 相近的 table。

**Interaction H → D0 Event Trace**

Interaction entropy 有兩個維度：

1. **Uncertainty（不知道怎麼做）** — 同一 outcome 有幾條不同路徑被用過
2. **Friction（知道但很累）** — 從第一個相關 event 到 outcome 的步驟數 + 時間差

Uncertainty 是 Shannon entropy，Friction 不是，但在工程上同樣重要（甚至更重要）。用戶可能只用一條路但那條路很痛苦，純路徑數捕捉不到。

```
Uncertainty ≈ log₂(同一 outcome 的不同路徑數)
Friction    ≈ mean(步驟數) + mean(耗時) per intent
```

Intent 不需要人工標註：用 outcome（最終的 DB write）反推，D0 裡的 source + actor 區分不同路徑。

#### 整體 Entropy

```
Total_H = w₁·H_semantic + w₂·H_structural + w₃·H_interaction
```

權重可調。不需要精確值，追蹤趨勢就夠：「這個月比上個月低」= 系統在變乾淨。

#### 核心態度

這套量化是為了讓 Optimizer 有 **可計算的目標函數**，不是為了學術嚴謹。Shannon entropy 給理論骨架，但實際要混用其他 proxy（friction、usage frequency）。能用的就用，不用硬套一個公式。

### Optimizer 運作模型

#### 隱私設計

- **預設 open**：Optimizer 能讀一切（doc 內容、D2 data、event payload）— 語意分析需要讀內容
- **Lock（opt-in）**：用戶主動 lock 的資料 → E2E encrypted → Optimizer 只看到 metadata（table name, row count, timestamps）
- Lock 的 key 只存在 client 端，server/Optimizer 永遠拿不到 plaintext

#### 執行模型

```
Cloud Optimizer (read-only 分析)
    ↓ 輸出 recommendations / design doc
User (讀建議，決定要不要做)
    ↓ 同意
Local Claude Code (在本地執行 migration)
```

Optimizer 沒有 DB write 權限。所有 schema 變更都由用戶在本地用 Claude Code 執行。

---

## 3. Data Architecture (D0 / D1 / D2)

### D0 — Raw Events (行為土壤，append-only)

> **「What happened?」的紀錄，不做解釋。**

來源：外部 connectors (ActivityWatch, Calendar, Oura) + 內部 (App UI events, CRUD events)

```sql
CREATE TABLE events (
  id          TEXT PRIMARY KEY,
  source      TEXT NOT NULL,
  kind        TEXT NOT NULL,
  actor       TEXT NOT NULL DEFAULT 'user',
  occurred_at INTEGER NOT NULL,
  payload     JSON NOT NULL,
  created_at  INTEGER NOT NULL DEFAULT (unixepoch('subsec')*1000)
);
```

特性：append-only，不 refactor，熵很高但保留完整歷史，未來可用更好的模型重新挖礦。

### D1 — Live Docs (高品質語意土壤)

> **你主動書寫/思考的地方。**

形式：MDX (Markdown + JSX)。是 LLM 最喜歡吃的 unstructured data。

```sql
CREATE TABLE docs (
  id          TEXT PRIMARY KEY,
  title       TEXT NOT NULL DEFAULT '',
  content     TEXT NOT NULL DEFAULT '',
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);

CREATE TABLE doc_versions (
  id          TEXT PRIMARY KEY,
  doc_id      TEXT NOT NULL REFERENCES docs(id),
  version     INTEGER NOT NULL,
  content_mdx TEXT NOT NULL,
  summary     TEXT,
  change_note TEXT,
  author      TEXT NOT NULL,
  created_at  INTEGER NOT NULL,
  UNIQUE (doc_id, version)
);
```

版本策略：不是每次 keydown 就 version++，而是有意義的 checkpoint（手動 save / session 結束 / 變更量 > 5%）。

Doc 編輯用 CRDT (Yjs) 處理 real-time 操作，fine-grained ops 可壓縮/丟棄。

### D2 — Structured SQL (沈澱後的世界模型)

> **把反覆出現的語意解釋沈澱成穩定 schema。**

每個 entity = 一張 SQL table（tasks, projects, focus_sessions, mood_logs...）

```sql
CREATE TABLE entities (
  id            TEXT PRIMARY KEY,
  name          TEXT UNIQUE NOT NULL,
  table_name    TEXT NOT NULL,
  json_schema   JSON NOT NULL,
  version       INTEGER NOT NULL DEFAULT 1,
  created_by    TEXT NOT NULL,
  promoted_from TEXT,
  created_at    INTEGER NOT NULL
);
```

所有 D2 table 強制附帶 namespace 欄位：`owner_app`, `created_by`, `updated_by`, `deleted` (soft delete)

### 資料沈澱路徑

```
L0 Raw Events (高噪音，append-only)
    ↓ adapter / LLM pipeline
L1 Live MDX (語意清楚，人類可讀)
    ↓ promote（跨 context 出現 + 多次被引用 = 穩定概念）
L2 SQL Tables (低熵、高密度、可查詢)
    ↓ 反方向
De-promote（長期沒用的 table → 降級回 unstructured）
Merge（重複的 table → 合併 schema）
```

---

## 4. System Architecture

### Runtime: Syntropy Capsule

每個 user = 一個 Capsule。Capsule 不是一台 server，是**一份 portable runtime 的多個 replica**。

```
┌─ Syntropy Runtime (一份 codebase) ─────────────────────┐
│                                                         │
│  Bun (single process)                                   │
│  ├─ HTTP server (API)                                   │
│  ├─ Guard Layer (所有 DB write 的唯一路徑)               │
│  ├─ Background workers (crons, connectors, ETL)         │
│  └─ App backends (user-installed + user-written)        │
│                                                         │
│  LibSQL (/data/syntropy.db)                             │
│  ├─ D0: events                                          │
│  ├─ D1: docs                                            │
│  ├─ D2: user tables                                     │
│  └─ meta: entities, integrations, app registry          │
└─────────────────────────────────────────────────────────┘
```

這份 runtime 跑在兩個地方，功能完全相同：

```
┌─ Desktop (Tauri) ──────────┐     ┌─ Fly.io ────────────────┐
│                             │     │                          │
│  Syntropy Runtime           │     │  Syntropy Runtime        │
│  (同一份 code)              │     │  (同一份 code)           │
│                             │     │                          │
│  + Tauri UI shell           │sync │  + Always-on (24/7)     │
│    ├─ MDX renderer          │◄───►│  + Sync endpoint        │
│    ├─ Editor (view/source)  │     │  + Litestream → R2      │
│    └─ Component rendering   │     │                          │
│                             │     │                          │
└─────────────────────────────┘     └──────────────────────────┘
  你電腦開著時用                       你電腦關了時用
  有 UI                               headless, always-on
```

Desktop 多了 **UI shell**（editor + renderer）。Fly.io 多了 **always-on + backup + sync endpoint**。其他完全一樣 — Guard、Crons、Connectors、ETL、App backend 兩邊都跑。

Fly.io 本質上是 local container 的 cloud replica + glue code（sync + backup + 24/7 uptime）。不是 server，是你的 runtime 的另一個 instance。

Desktop 不是 thin client — 它是完整 runtime，天然 offline capable。Fly.io 掛了你一樣能用，只是 connector sync 暫停。

### 不可逆的技術賭注

| 賭注 | 選擇 | 為什麼安全 |
|------|------|-----------|
| DB 格式 | SQLite (LibSQL) | 地球上部署量最大的 DB 格式，sync 生態最活躍 |
| Container 格式 | OCI image | 產業標準 |
| 語言生態 | JS/TS (Bun) | AI coding 主力語言 |
| 資料架構 | Single DB per user | 跨 module 查詢天然打通 |

可以換的：Fly.io（換任何 Docker host）、前端框架、LLM provider、具體 table schema

### Guard Layer

所有 DB write 的唯一路徑。三個職責：

1. **自動注入 metadata** — `owner_app`, `created_by`, `updated_by`
2. **Namespace 保護** — App 只能寫自己 namespace 的 table
3. **自動記 D0 event** — 每次 D2 寫入都在 events 留紀錄

D1 只需要做第 3 點（管道先建好）。Namespace 保護等有多個 AI-generated app 時再加。

### Sync（Desktop ↔ Fly.io replica 同步）

兩個 runtime instance 之間的 sync，按 data layer 分策略：

- **D0 Events**: append-only → bulk push，無衝突
- **D1 Live Docs**: Yjs CRDT → 天然支持多 replica concurrent editing
- **D2 Structured**: row-level sync, `_version` + LWW（single user，不需要 multi-user CRDT）

漸進式路線：

```
Phase 1:  單一 instance（先跑 Fly.io or 先跑 local，不 sync）
  ↓
Phase 2:  Litestream → R2/S3（backup，非 sync）
  ↓
Phase 3:  Desktop ↔ Fly.io bidirectional sync（D0 bulk push + D1 Yjs + D2 LWW）
  ↓
Phase 4:  多設備 sync（cr-sqlite or Turso managed replicas）
```

Desktop 本身是完整 runtime，offline 時所有功能正常。上線後 sync 差異到 Fly.io replica。

---

## 5. Agent Roles (20260214 note: 感覺微妙的過時了? 需要重新思考 agent)

| Agent | 職責 | 操作對象 | 位置 |
|-------|------|---------|------|
| **Architect** | 建構 / 演化 App & Schema | E5 (Apps) + E4 (Schema) | 後端 worker + CLI |
| **Optimizer** | 維護 / merge / 清理 / 熵管理 | E1 (Data) + E4 (Schema) | 背景 cron |
| **Companion** | 即時輔助 / 對話 / 寫文 | E3 (Live Docs) | 前端 / edge function |
| **Worker** | App 內自動化執行 | D2 tables (scoped) | App runtime |

商業定位：
- Architect = **CTO-as-a-Service**（高價值，用戶付費）
- Optimizer = **COO-as-a-Service**（低成本背景運行）
- Companion = 將短暫互動轉化為永久價值
- Worker = 簡化 App 內邏輯

---

## 6. App Model

### 組成

- 前端 code：React component(s)
- Manifest：描述需要什麼、可以操作什麼

```json
{
  "id": "focus_timeline",
  "name": "Focus Timeline",
  "required_entities": ["focus_sessions"],
  "permissions": { "focus_sessions": ["read"] },
  "entry_component": "FocusTimeline"
}
```

### Promote Lifecycle

```
Ephemeral（Companion 在 Live Doc 裡生成臨時組件）
  ↓ 用戶點 "Save as App"
Permanent（Architect 封裝成 App + 建立正式 Schema）
```

### 權限規則

- **Namespace Ownership**: App 只能寫自己創造的 table
- **Universal Read**: 任何 App 可以 SELECT 任何 table
- **敏感資料例外**: 需要 User Grant

### Marketplace (未來)

分享的是 App + Manifest，不是資料。安裝時 Architect 檢查用戶 DB 是否有對應 entity。

### 20260214 演化：Everything is a View + Syntropy as OS

> 核心 insight：MDX 統一了 doc 和 frontend（view layer）。但 app 不只是 frontend — 用戶的 personal system 是完整的 full-stack project。

**View layer 的統一（MDX）：**

上面的 App Model（Manifest + Promote Lifecycle）是 Nov 2025 的設計，假設 Doc 跟 App 是兩個不同的東西。後來發現在 view layer 它們本質相同 — 一個 page = 一份 MDX，差別只在 text 跟 component 的比例。

這跟 Manifest-based App Model 不矛盾，而是簡化了 view 層：
- 早期不需要 Manifest。一個 page 引用哪些 component 就是它的「manifest」。
- Promote lifecycle 依然成立，但不是「Doc → App」的切換，而是 page 裡自然長出更多 component。

**但 App ≠ Page：**

MDX page 只是 app 的 frontend face。一個完整的 app 可能包含：

```
App = View layer + Backend logic + D2 schema
├── Page (MDX)           ← 用戶在 editor 裡看到的
├── Components (React)   ← 嵌在 MDX 裡的 UI 元件
├── Backend logic        ← cron jobs, API routes, ETL pipelines, automations...
└── D2 schema            ← app 需要的 table 結構
```

用戶通過 Claude Code 開發 backend logic，這是他們 personal system 的一部分。Syntropy 提供 runtime（DB + Guard + Editor + Optimizer），用戶在上面 build 自己的 full-stack applications。

**所以 Syntropy 是 OS，不是 app。** 就像 OS 跟 application 的關係 — 提供 data layer + editor + conventions，用戶在上面蓋自己的系統。

**Editor 設計 — View/Source 雙模式：**

```
View mode:  rich text editing (text 部分) + component 正常互動 (component 部分)
            類似 Obsidian 的閱讀/編輯體驗

Source mode: 看到 raw MDX，可以手動改 props、調整結構
```

**Sidebar 結構：**

```
PAGES          ← 所有 user pages，不區分 doc/app
  📄 Home
  📄 Tasks
  📄 Weekly
  📄 Journal

SYSTEM         ← 平台級 views（非 user content）
  ⚙️ Settings
  🔧 Optimizer
  🔌 Connectors
```

**AI 策略：**

- **Optimizer**：唯一需要自己 build 的 AI — 雲端背景跑，proactive entropy 管理
- **Builder（Architect/Companion/Worker）**：不需要自己 build — 用戶在 terminal 用 Claude Code / Codex，讀 CLAUDE.md 就能擴展系統
- **CLAUDE.md 是 product**：寫好 conventions，任何 LLM CLI tool 都能幫用戶擴展系統，不綁特定 LLM provider

---

## 7. Data Connector / Integration

### 核心原則

> 一個 connector =「把外部世界的 event 轉成 D0 event」的 adapter。不在 connector 裡堆邏輯。

### 四個抽象

1. **Source** — string id（google_calendar, activitywatch, oura...）
2. **Integration** — user 與 source 的一段關係（`integrations` table）
3. **Connector** — 程式碼層的 plugin interface
4. **RawEvent** — 進入 D0 的唯一格式

```ts
interface Connector {
  id: string;
  kind: 'pull' | 'webhook' | 'one_time_import';
  startAuth(): Promise<AuthState>;
  finishAuth(callback: any): Promise<AuthState>;
  sync(params: {
    auth: AuthState;
    syncState: any;
    emit: (e: RawEvent) => void;
  }): Promise<{ nextSyncState: any }>;
}
```

### Connector 優先級

- **Tier 1（早做）**: ActivityWatch, Oura, Calendar — 只讀、結構化、低隱私風險
- **Tier 2（設計好 UX 再上）**: Email, Slack, Browser content — 高價值但高敏感
- **Tier 3（成熟後）**: 雙向 action connectors — 替你回 email、改 calendar

### 已完成的 PoC

- ActivityWatch: 已下載 + aw-sync 完成
- Oura: 需要看 API docs
- iOS: 需要開發 native app (TestFlight)

---

## 8. Promote / ETL 機制

### D0 → D2 (行為 → 結構)

場景：ActivityWatch + ScreenTime + Calendar → `focus_sessions`

流程：
1. Poll events where unprocessed
2. Adapter code: deterministic preprocessing + LLM for semantics
3. 產生 D2 rows → 透過 Guard insert
4. 標記 event 已處理

### D1 → D2 (敘事 → 結構)

場景：日記中寫「今天 3-5pm 在修 app，有點累」→ 抽取 worklog + mood_log

流程：
1. Trigger（手動 or Optimizer 自動）
2. 準備 input：doc content + available D2 schemas
3. LLM → JSON output
4. JSON Schema 驗證
5. 透過 Guard 寫入 D2
6. Human-in-the-loop review

---

## 9. Use Cases (已規劃的應用)

### Personal Time Tracking

**Data sources:**
- Desktop: ActivityWatch (window + AFK + web events)
- Mobile: iOS native app (Screen Time API + intention tagging + Motion + GPS)
- Health: Oura API (sleep, readiness, activity, heart rate, SpO2, workout)
- Browser: ActivityWatch Chrome Extension

**iOS App 概念:**
- 所有 app 預設鎖定
- 使用時選 app + 標記意圖 (work/entertainment/other) + 設定時長
- Cross-reference Screen Time API 實際使用時間
- Smart defaults + 快速預設 + 批次解鎖

### Personal Health Monitoring

- 輸入長年健檢 baseline, 基因資訊, 近期檢測, 家族史
- 根據年齡/地點評估死亡率
- Access time tracker data
- 追蹤亞健康狀態
- 數據推力分層（Tier 1-5）：從一般性建議到 correlation + 預測 + 成本

---

## 10. Product & Business

### Target Market

Solopreneurs / 會用 Claude Code 構建 personal system 的人

### Product 形態

不是一個 web app，也不是一個 backend scaffold。是一個 **personal system runtime**：
- 形態：Desktop app (Tauri) + cloud replica (Fly.io)，同一份 codebase
- Desktop app：editor (view/source mode) + MDX renderer + 完整 runtime（offline capable）
- Fly.io：同一個 runtime 的 cloud instance（always-on connectors, sync endpoint, backup）
- 擴展方式：用戶在 terminal 用 Claude Code / Codex，讀 CLAUDE.md 擴展系統
- 最重要的檔案：`CLAUDE.md`（conventions，讓任何 LLM CLI tool 都能擴展系統）
- 價值：所有 data 在同一個 DB，系統越用越乾淨，用戶擁有完整 infra

### 6 個核心抽象組件

1. **Live Docs** — human-readable content
2. **User Action Flow** — behavior analysis + Context Layer
3. **Data Connector** — external integration
4. **Apps** — dynamic functionality (disposable)
5. **Structured Data** — machine-readable data
6. **Auto Optimize** — proactive intelligence (Optimizer)

---
20260214 對這部分的理解
1. **Live Docs** — human-readable content (MDX)
2. **User Action Flow** — behavior analysis + Context Layer
3. **Data Connector** — external integration
4. **Apps** — dynamic functionality (disposable)
5. **Structured Data** — machine-readable data
6. **Auto Optimize** — proactive intelligence (Optimizer)

### 公司與命名

- 公司: Adiabatic Inc. (github.com/adiabatic-dev)
- 產品: Syntropy OS, 簡稱 Syn
- Repo: syntropy-os

### GTM 策略

1. Internal first — 先解決自己的需求
2. Building in public — 開發過程作為 marketing
3. 不要 Day 1 就 open source — 還不知道什麼該 open

### Open Core 策略

- Open-source runtime for hosting AI-generated apps with unified data layer
- Runtime infra open, data/code exportable
- 整合 app building + personal system improve + marketplace
- 參考 n8n fair license

### 競爭分析

| 維度 | 最接近的競品 | Syntropy 的差異 |
|------|------------|----------------|
| Local-first | Anytype | Syntropy 有 AI-generated views, SQL data layer |
| Per-user container | Deta Space (已關) | Syntropy 有殺手應用（entropy engineering） |
| AI 生成 app | v0.dev, Lovable | Syntropy 有 persistent personal data layer |
| Knowledge management | Obsidian | Syntropy 有 structured data (D2) + AI agents |

### 真正的差異化

不是技術架構。是：**系統越用越乾淨，不是越用越亂。** 市面上沒有產品把這個當核心 value prop。

---

## 11. What's Deprecated (已被後期思路覆蓋)

| 早期設計 | 被什麼取代 | 出處 |
|---------|-----------|------|
| Supabase + Postgres | SQLite/LibSQL per-user capsule | Time Tracking doc (Oct) → System Design (Nov) |
| Row Level Security (RLS) | Guard Layer | Time Tracking doc → System Design |
| Multi-tenant schema | Single-user isolation | Enterprise doc → System Design |
| `users` table + `user_id` FK | 不需要，single user per DB | Time Tracking doc → Capsule model |
| Supabase Edge Functions | Bun server in container | Time Tracking doc → System Design |

---

## 12. D1 Action Items

極簡起步：

```
syntropy/
├── CLAUDE.md              ← 最重要：讓 AI 能直接擴展系統
├── fly.toml
├── Dockerfile
├── package.json
├── src/
│   ├── index.ts           ← Bun HTTP server
│   ├── db.ts              ← SQLite init (events + docs)
│   └── guard.ts           ← 所有寫入的唯一路徑
└── /data/
    └── syntropy.db
```

1. `bun init` + HTTP server
2. `syntropy.db` init（events + docs 兩張表）
3. Guard v0（一個 write function，現在只記 D0 event）
4. Dockerfile + fly.toml → `fly deploy`
5. Litestream → R2 backup（D1 就要做，Fly volume 不可靠）
6. 第一個 module: docs CRUD → 證明 loop 跑得通
