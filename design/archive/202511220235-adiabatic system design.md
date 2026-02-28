
Problem: live doc 的 edit event / version 可能要特別處理
[[202511220244-Adiabatic D1 Live Doc high level]]

[[frgkth]]

好，我們來把整套東西「工程化寫清楚」，順便在關鍵設計點補一點哲學 context（為什麼這樣做）。

我會照這個順序講：

1. 整體架構總覽
    
2. 資料層：D0 / D1 / D2 技術細節
    
3. Guard Layer（取代 RLS 的黑盒）
    
4. Promote / ETL 機制（D0→D2, D1→D2）
    
5. Integration / Connector 設計
    
6. App / Manifest / Share 模型
    
7. Agents（Architect / Optimizer / Companion / Worker）
    
8. 跟「熵工程」的對應
    

---

## 1. 整體架構總覽

### 1.1 Runtime 拆層

**每個 user = 一個 Adiabatic Capsule**：

- **LibSQL / SQLite DB**（sqld）
    
- **Next.js / Bun app server**
    
- **Background workers**（定時 job + LLM ETL）
    
- （可選）object storage（存 raw export / snapshot）
    

部屬形態：

- Fly.io：`1 container + 1 volume` per user（或 per paid workspace）
    
- Local dev：一顆 `adiabatic.db` + local Next.js
    

> 🧠 _哲學 context_：  
> 「一人一顆宇宙」，你的人生系統不應該 share multi-tenant schema。  
> Capsule = 物理上的「個人宇宙」單位。

---

## 2. 資料層：D0 / D1 / D2

### 2.1 D0 – Raw Events（行為土壤，append-only）

**來源**：

- 外部：ActivityWatch, iOS ScreenTime, Google Calendar, GitHub, Oura…
    
- 內部：
    
    - App UI event（打開哪個 view、點了哪個按鈕）
        
    - CRUD event（對 D2 做了哪些變更）
        

**目標**：

- 這一層只做「**What happened?**」的紀錄，不做解釋。
    
- 任何後續的語意 / 結構，全部從這邊推導。
    

**代表 schema（簡化版）：**

```sql
CREATE TABLE events (
  id            TEXT PRIMARY KEY,           -- uuid
  kind          TEXT NOT NULL,             -- 'external' | 'app_ui' | 'app_crud'
  source        TEXT NOT NULL,             -- 'activitywatch' | 'ios_screen_time' | 'calendar' | 'focus_app' ...
  external_id   TEXT,                      -- 去重用
  actor         TEXT,                      -- 'system' | 'user' | 'app:<app_id>'
  started_at    INTEGER NOT NULL,          -- unix ms
  ended_at      INTEGER,                   -- 可為 null
  payload       JSON NOT NULL,             -- 原始資料（不動）
  created_at    INTEGER NOT NULL DEFAULT (unixepoch('subsec'))
);

CREATE INDEX idx_events_source_time 
  ON events(source, started_at DESC);
```

**In-app CRUD event 的 payload 例子：**

```json
{
  "entity": "tasks",
  "entity_id": "task_123",
  "action": "update",
  "before": { "status": "todo" },
  "after":  { "status": "doing" },
  "doc_id": "doc_abc",     // 發生在哪篇 live doc 的 context 裡
  "app_id": "task_board"
}
```

> 🧠 _哲學 context_：  
> D0 是「生命紀錄黑盒」。  
> append-only 的好處是：**我們永遠可以回頭重新詮釋過去，而不是被當下的說法鎖死。**  
> 這是對抗「語意後悔」的保險。

---

### 2.2 D1 – Live Docs（高品質語意土壤）

**定位**：

- 你**主動書寫 / 思考**的地方：日記、反思、規劃、設計稿…
    
- 形式：**MDX（Markdown + JSX）**
    
- 是 AI 最喜歡吃的 unstructured data：
    
    - 自然語言
        
    - inline struct（表格、lists）
        
    - inline App（React component）
        

**代表 schema：**

```sql
CREATE TABLE docs (
  id          TEXT PRIMARY KEY,
  title       TEXT,
  doc_type    TEXT,                -- 'journal' | 'design' | 'log' ...
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL,
  content_mdx TEXT NOT NULL        -- 全文 MDX
);

-- optional: 分塊索引 / 檢索用
CREATE TABLE doc_embeddings (
  id          TEXT PRIMARY KEY,
  doc_id      TEXT NOT NULL REFERENCES docs(id),
  block_path  TEXT NOT NULL,       -- ex: 'h2[1]/p[3]'
  embedding   BLOB NOT NULL
);
```

**內含兩種特別元素**（出現在 `content_mdx` 裡）：

1. **Data 引用**
    
    ```md
    今天完成了任務 [[entity:tasks/123]]，感覺還不錯。
    ```
    
2. **App 組件**
    
    ```mdx
    <Timeline appId="focus_timeline" query="last_7_days" />
    ```
    

> 🧠 _哲學 context_：  
> D1 是「你真正在思考的地方」，而不是 database GUI。  
> 真正的「自我」體驗長在這裡 → 所以 D1 是語意熵管理的核心，要被 LLM 優先處理。

---

### 2.3 D2 – Structured SQL（沉澱後的世界模型）

**定位**：

- 把「重複出現的語意解釋」沈澱成**穩定 schema**。
    
- 給 App / Dashboard / Optimizer 用的主要資料層。
    

**實作方式：**

1. **每個 Entity = 正常 SQL table**
    
    - 例如：`tasks`, `projects`, `focus_sessions`, `mood_logs`…
        
2. 再用一張「註冊表」管理 metadata：
    

```sql
CREATE TABLE entities (
  id            TEXT PRIMARY KEY,
  name          TEXT UNIQUE NOT NULL,    -- 'tasks', 'focus_sessions', ...
  table_name    TEXT NOT NULL,           -- 實際表名
  json_schema   JSON NOT NULL,           -- D2 JSON Schema（給 LLM 看）
  version       INTEGER NOT NULL DEFAULT 1,
  created_by    TEXT NOT NULL,           -- 'system' | 'user' | 'app:<id>'
  promoted_from TEXT,                    -- 'D0' | 'D1' | 'manual'
  created_at    INTEGER NOT NULL
);
```

**Row namespace（避免 apps 互相搞爛彼此資料）**：  
所有 D2 實體 table 都**強制附帶這些欄位**：

```sql
owner_app   TEXT NOT NULL,     -- 'system' | 'time_tracker' | 'journal_app' ...
created_by  TEXT NOT NULL,     -- 'user' | 'app:<id>'
updated_by  TEXT NOT NULL,
deleted     INTEGER NOT NULL DEFAULT 0,  -- soft delete flag
deleted_by  TEXT,
deleted_at  INTEGER
```

> 🧠 _哲學 context_：  
> D2 是「你目前世界模型的快照」。  
> 它是**可 refactor 的**，但 refactor 永遠只在這一層發生；  
> D0 / D1 不 refactor，確保「過去的 raw 證據」永遠保留。

---

## 3. Guard Layer：所有 DB 操作走這關

你不讓 App 直接打 SQL，而是走一個 TypeScript SDK / server API：

```ts
await db.insert('tasks', data, { appId: 'time_tracker' })
await db.update('tasks', where, patch, { appId: 'time_tracker' })
await db.softDelete('tasks', where, { appId: 'time_tracker' })
await db.query('SELECT ...', { appId: 'timeline_app' })
```

### 3.1 Guard 作什麼？

1. **注入 row namespace**
    
    - `owner_app`：只能在第一次 insert 設定，且預設 = 呼叫者 appId
        
    - `created_by / updated_by`：自動帶 `app:<id>` or `user`
        
    - `deleted`：永遠用 soft delete，禁止 app 直接 hard delete
        
2. **記 event → D0**
    
    每一次 D2 寫操作，都會自動記一筆 D0 event：
    
    ```json
    {
      "kind": "app_crud",
      "source": "app:time_tracker",
      "actor": "app:time_tracker",
      "payload": {
        "entity": "tasks",
        "entity_id": "task_123",
        "action": "update",
        "before": { "status": "todo" },
        "after":  { "status": "doing" }
      }
    }
    ```
    
3. **Drop / schema 變更權限管制**
    
    - 一般 App **不允許**：
        
        - `DROP TABLE`
            
        - `ALTER TABLE`（新增欄位例外，可以做白名單）
            
    - 只有 Architect / system migration 可以做 DDL。
        

> 🧠 _哲學 context_：  
> 我們不希望「每張表一套 RLS 規則、每個 app 各種例外」→ 結構熵爆炸。  
> 所以權限、owner、軌跡全收斂到「一個 Guard 黑盒」，  
> 讓上層 schema / app 設計乾淨很多。

---

## 4. Promote / ETL 機制

### 4.1 D0 → D2（行為 → 結構）

**場景**：

- ActivityWatch + ScreenTime + Calendar → `focus_sessions`
    
- Oura → `sleep_summary`, `readiness_daily`
    

**技術路線**：

- **Adapter registry** + background worker
    
- Adapter 可以是：
    
    - 純 code（TypeScript）
        
    - 或「LLM 補語意 + code 做最後 mapping」
        

**Adapter metadata 表：**

```sql
CREATE TABLE adapters (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,           -- 'aw_focus_sessions'
  source_kind   TEXT NOT NULL,           -- 'activitywatch', 'calendar'
  target_entity TEXT NOT NULL,           -- 'focus_sessions'
  transformer   TEXT NOT NULL,           -- 存 code 或指向 code 檔
  version       INTEGER NOT NULL DEFAULT 1,
  status        TEXT NOT NULL,           -- 'draft' | 'active' | 'deprecated'
  created_at    INTEGER NOT NULL
);
```

**Worker 大致流程：**

1. poll `events` where `source = 'activitywatch' AND processed_by_adapter_x IS NULL`
    
2. 呼叫 adapter code：
    
    - 先做 deterministic preprocessing（group by time, merge連續使用）
        
    - 需要語意時呼叫 LLM
        
3. 產生 D2 rows → 透過 Guard `insert`
    
4. 標記 event 已處理 / 或記一個 `processed_events` table
    

> 🧠 _哲學 context_：  
> 這條線是「被動觀察 → 行為模型」：  
> 你怎麼花時間、在哪裡、跟誰，是被動被紀錄成世界模型的一部分。

---

### 4.2 D1 → D2（敘事 → 結構）

**場景**：

- 日記中寫：「今天 3–5pm 一直在修剪 caption app，有點心累。」
    
- 你希望自動抽成：
    
    - 一筆 `worklogs`
        
    - 一筆 `mood_logs`
        

**LLM ETL Pipeline（簡化版）**：

1. **Trigger**
    
    - 你按「抽取結構化資料」
        
    - 或每天晚上 Optimizer 自動跑
        
2. **Prepare input**
    
    - `doc_content`：MDX 全文 / 部分 section
        
    - `available_entities`：從 `entities.json_schema` 拉出所有 D2 schema
        
    - 加上 user 偏好（例如不想 auto 產生 task）
        
3. **LLM prompt → JSON output**
    
    - 請 LLM 輸出：
        
        ```json
        {
          "tasks": [ ... ],
          "mood_logs": [ ... ],
          "worklogs": [ ... ]
        }
        ```
        
4. **Validation + mapping**
    
    - 用 D2 的 JSON Schema 驗證
        
    - 欄位 alias / default（ex: `state` → `status`）
        
5. **Write**
    
    - 透過 Guard insert/ upsert
        
    - 同時在 row 裡記：
        
        ```sql
        source_doc_id    TEXT
        source_block     TEXT   -- optional，用來 highlight 原文位置
        ```
        
6. **Human-in-the-loop 修正**
    
    - UI 給你一個 review 視圖
        
    - 你可以刪掉 / 修改
        
    - 你的更正樣本可以被記成「下次 prompt 的 few-shot example」
        

> 🧠 _哲學 context_：  
> 這條線是「主觀敘事 → 可運算的 self-model」。  
> 把你對自己的描述，慢慢壓成 D2，可以讓系統真的理解「你是誰、你在乎什麼」。

---

## 5. Integration / Connector 設計

### 5.1 高層原則

- **所有外部來源 → 只寫 D0 `events`**
    
- **不承諾「雙向同步 state」**（避免 Zapier / n8n 那種地獄）
    
- 整合分兩類：
    
    1. **純 read**：Calendar, GitHub, Oura, Notion export…
        
    2. **高權限 / 敏感**：截圖、ScreenTime、硬體 sensor → 做成「Battery / Plugin」
        

### 5.2 Ingestion API

**HTTP API**（跑在你的 Capsule 裡）：

`POST /api/ingest/events`

Body：

```json
{
  "source": "google_calendar",
  "events": [
    {
      "external_id": "cal_123",
      "started_at": 1732300000000,
      "ended_at": 1732303600000,
      "payload": {
        "title": "1:1 with manager",
        "attendees": ["boss@example.com"],
        "location": "Meet",
        "description": "performance review..."
      }
    }
  ]
}
```

Server 端：

- 驗證 token（integration-specific）
    
- 寫入 D0 `events`
    
- 不做任何解釋（那是 adapter 的工作）
    

### 5.3 Integration Management

表 `integrations`：

```sql
CREATE TABLE integrations (
  id           TEXT PRIMARY KEY,
  kind         TEXT NOT NULL,     -- 'google_calendar' | 'oura' | 'notion_export' ...
  status       TEXT NOT NULL,     -- 'connected' | 'error' | 'disconnected'
  last_sync_at INTEGER,
  metadata     JSON,              -- 存 token endpoint 之類
  created_at   INTEGER NOT NULL
);
```

UI：

- 開關各個 integration
    
- 顯示 last sync / 錯誤
    
- 可以 revoke / delete
    

> 🧠 _哲學 context_：  
> 「所有外部東西先進 D0，再慢慢沈澱」，  
> 統一 data path 可以壓制整個系統的結構熵，避免 「每接一個 service 就多一套 schema」。

---

## 6. App / Manifest / Share 模型

### 6.1 App 組成

一個 App ≈：

- **前端 code**：React component(s)
    
- **Manifest**：描述它需要什麼、可以操作什麼
    

Manifest 例子（TypeScript object or JSON）：

```json
{
  "id": "focus_timeline",
  "name": "Focus Timeline",
  "description": "Visualize your focus sessions by day.",
  "required_entities": ["focus_sessions"],
  "permissions": {
    "focus_sessions": ["read"]
  },
  "entry_component": "FocusTimeline"
}
```

Guard + App runtime 根據這個 manifest：

- 限制 query：只能 `SELECT` `focus_sessions`
    
- 不能對其他表 `insert / update`
    

### 6.2 Share & Marketplace

**分享的是「App + Manifest」，而不是資料。**

安裝流程：

1. 別人安裝 `focus_timeline` app
    
2. Architect agent 檢查他 DB 裡是否有 `focus_sessions` entity
    
    - 沒有 → 建議 from D0 推一個 schema
        
    - 有但欄位不完全吻合 → 做 mapping / alias 建議
        
3. 你確認後，App 就能用他自己的 D2 table
    

> 🧠 _哲學 context_：  
> App 是「解釋器 + UI」，真正的 asset 是你的 data。  
> Marketplace 不是在「藏 data」，而是在「分享好的解釋模板」。

---

## 7. Agents Runtime

### 7.1 Companion（前台 + Live Doc）

**位置**：前端 / edge function

- 拿 D1 Doc + 當前 context（最近 D2 查詢結果）
    
- 幫你寫文、抽 task、嵌入 App
    
- 可以呼叫：
    
    - `db.query`（read-only）
        
    - `db.insert/update`（透過 Guard）
        

### 7.2 Architect（Schema & App Builder）

**位置**：後端 worker + CLI

職責：

- 建立 / 修改 `entities`（新增 table、調整欄位）
    
- 建立 / 更新 App manifest / code skeleton
    
- 提議新的 D2 schema（當 D0 / D1 出現固定 pattern）
    

技術：

- 使用 LLM 生成：
    
    - SQL DDL migration
        
    - JSON Schema
        
    - React Component scaffold
        
- 執行前要求你 manual approve（至少 MVP 時）
    

### 7.3 Optimizer（熵管理員）

職責：

- 定期掃：
    
    - D0 使用 pattern（哪些 event 被常用 / 閒置）
        
    - D1 Docs（哪些結構一直重複出現）
        
    - D2 tables（哪張表欄位太多、哪張表長期沒用）
        
- 動作：
    
    - 提議 merge / split D2 tables
        
    - 提議 retire 不常用的 Entities / Apps
        
    - 更新 index、產生物化 view、清理過期 cache
        

### 7.4 Worker（App 內 automation）

- 每個 App 內可以定義小型 automation（code + cron)
    
- 運行時：
    
    - 可以 `SELECT` 它有權限的 D2 tables
        
    - 透過 Guard 更新 row（產生 D0 CRUD events）
        

> 🧠 _哲學 context_：  
> 你不需要一個巨大的「通用 workflow engine」。  
> Worker + Guard + code+cron 就夠，真正的「熵管理」在 Optimizer / Architect 那層做。

---

## 8. 跟「熵」的對應（很短講一下）

- **語意熵（Semantic entropy）**
    
    - D0/D1 很亂 → 透過 D0/D1→D2 的 LLM ETL pipeline，
        
    - 把「反覆出現的解釋」變成穩定 schema，降低語意熵。
        
- **結構熵（Structural entropy）**
    
    - 一堆 entities / tables / app schema →
        
    - 用 `entities` registry + Guard + Architect + Optimizer 集中管理，
        
    - 避免每個地方自己定義一套權限 / schema。
        
- **交互熵（Interaction entropy）**
    
    - User 不用切 N 個工具、填 N 種 form：
        
    - 把**互動入口壓到 Live Doc / Companion**，
        
    - 讓 promote / extract 變成順手帶到的行為。
        

> 最後一句話：  
> **整個技術設計，就是在用「階層化資料 + Guard + Agents」  
> 把你的 life log 變成一個會自我整理、可運算、可演化的個人 OS，  
> 而不是新的 Notion 墳場。**

如果你接下來想開始實作，我可以幫你把：

- `events` / `docs` / `entities` 最小版 schema
    
- Guard Layer TypeScript SDK v0
    
- 第一個 D0→D2 adapter（ActivityWatch → `focus_sessions`）
    

寫成一份「Adiabatic Capsule MVP 技術規格 + 任務拆解」。


---
Code 是 include anything including LLM API 的 (LLM API 會被做成 sdk)