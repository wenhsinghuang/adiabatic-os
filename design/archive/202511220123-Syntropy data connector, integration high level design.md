
好，回到 **data connector / integration 的高階設計**，我幫你整理成一套「可以長期擴張、但一開始很好做」的框架。

我會用你現在的世界觀來講：  
**L0 / L1 / App、single-user capsule、LibSQL、Architect / Optimizer / Companion。**

---

## 0. 先定義一句話版本

> **一個 connector =「把外部世界的一條 event，轉成 Syntropy L0 event」的 adapter。**  
> 其它所有事（結構化、關聯、App、分析）全部交給內部系統做。

這意味著：

- **不做 n8n 那種「在 connector 裡堆邏輯 / workflow」**
    
- connector **只負責三件事**：
    
    1. authenticate（拿到 token）
        
    2. pull / receive 原始資料
        
    3. 塞進你的「通用 L0 event 格式」
        

你就可以維持：

- 低結構熵（connector 不帶業務邏輯）
    
- 高語意可塑性（之後想怎麼解釋都行）
    

---

## 1. 核心抽象：四個名詞就夠用

### 1️⃣ Source（資料來源）

- 例：`google_calendar`, `activitywatch`, `oura`, `notion_export`, `obsidian_vault`, `email`, `github`
    
- 只是一個 **string id**，出現在 `events_l0.source` 裡
    

### 2️⃣ Integration（這個 user 與某個 source 的一段關係）

LibSQL 裡一張表（單 user 也先這樣做，未來 multi-tenant 可沿用）：

```sql
CREATE TABLE integrations (
  id TEXT PRIMARY KEY,
  source TEXT NOT NULL,          -- 'google_calendar'
  status TEXT NOT NULL,          -- 'connected' | 'error' | 'disabled'
  auth JSON,                     -- access_token, refresh_token, etc
  sync_state JSON,               -- cursor, last_synced_at, page_token
  created_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ
);
```

> **你所有「Connect Calendar / Connect Oura / Import Notion」的按鈕 → 就是在創/改這一行。**

### 3️⃣ Connector（程式碼層的 plugin）

對你未來 open-core 很重要的一層抽象：

```ts
interface Connector {
  id: 'google_calendar' | 'activitywatch' | ...
  kind: 'pull' | 'webhook' | 'one_time_import';

  // 第一次 connect 時用來產生 auth JSON
  startAuth(): Promise<AuthUrlOrPKCE>;
  finishAuth(callbackPayload): Promise<AuthState>; // 產出 integrations.auth

  // background job 會呼叫
  sync(params: {
    auth: AuthState;
    syncState: any;     // integrations.sync_state
    emit: (e: RawEvent) => void;
  }): Promise<{ nextSyncState: any }>;
}
```

---

### 4️⃣ RawEvent（你的一招吃天下格式）

這是進入 LibSQL 的「唯一入口」：

```ts
type RawEvent = {
  source: string;          // 'google_calendar'
  external_id: string;     // event id / message id / file path ...
  occurred_at: string;     // 真實世界的時間
  received_at: string;     // 寫入 Syntropy 的時間
  kind: string;            // 'calendar.event.created' | 'window.focus' ...
  payload: any;            // 原始 JSON，盡量完整
};
```

對應到 L0 table：

```sql
CREATE TABLE events_l0 (
  id TEXT PRIMARY KEY,
  source TEXT NOT NULL,
  external_id TEXT,
  occurred_at TIMESTAMPTZ NOT NULL,
  received_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  kind TEXT NOT NULL,
  payload JSON NOT NULL
);

CREATE UNIQUE INDEX idx_events_l0_dedup
  ON events_l0(source, external_id, kind, occurred_at);
```

> **所有 connector 的最終使命 = call `emit(rawEvent)`，別的都不要做。**

---

## 2. Data flow 高階圖

用你現在的層級來看整條路徑：

```text
[External World]
  ├─ Google Calendar
  ├─ ActivityWatch
  ├─ Notion Export
  └─ Obsidian Vault
        │
        ▼
[Connector Code]
  - Auth
  - Pull / Receive
  - Wrap 成 RawEvent[]
        │
        ▼
[L0: events_l0]
  - append-only events
  - full payload as JSON
        │
        ▼
[Adapter / Architect / Optimizer jobs]
  - 某些 source + kind → 變成 L1 table row (tasks, journal...)
  - 建 index, vector embedding, relation
        │
        ▼
[L1: Structure DB (LibSQL tables + vec)]
        │
        ▼
[L2: Apps + Views + Live Docs]
```

你真正的「產品跟模型魔法」全部發生在 **L0 → L1 → L2**。  
**Connector 是 plumbing，不是腦。**

---

## 3.「要不要做」的分層：三個優先級

你剛剛問的是 high level design，但背後其實是：  
**哪些 connector 現在要做 / 哪些先不碰。**

### 🚦 Tier 1：幾乎零風險 + 高價值（早做）

- **ActivityWatch（Desktop metadata）**
    
- **Oura / 健康 wearable**
    
- **Calendar**
    

特徵：

- 只讀、多數人直覺不覺得侵犯隱私
    
- 資料高度結構化，容易進 L0
    
- 之後 L1 可以極容易產生有價值的 insight（睡眠 vs 工作 / meeting vs focus）
    

👉 這些可以直接做成 **常駐 sync connector**（定時 job 呼叫 `connector.sync`）。

---

### 🚧 Tier 2：高價值 + 高敏感度（設計好 UX 再上）

- **Email**
    
- **Slack / Discord**
    
- **Browser content-level（非只 metadata）**
    

這些很適合 L0，但：

- 需要 **非常清楚的 opt-in 說明 + 可刪除機制**
    
- 可能需要「只 ingest metadata / header，不 ingest full content」的模式
    

👉 這些可以先當未來 roadmap，L0 架構先支持，但不急著實作 connector。

---

### 🔒 Tier 3：成熟後才考慮的「行動型 integration」（actions）

- 替你自動回 email、改 calendar、發 Slack
    
- 對外系統「寫」的 connector
    

這種我會建議：

- 一開始只當「App layer 功能 + outbound webhook + log 回 L0」
    
- 不要一開始就做「雙向強耦合的 sync 系統」
    

---

## 4. Integration Management：你 UI 只需要這幾個欄位

你前面有提到：

> 外部 source → ingest API → events table  
> 然後有 integration management

那個 management 頁面其實可以非常簡單：

對應 `integrations` table：

- Source name（Calendar / Notion / Obsidian / ActivityWatch）
    
- Status: `Connected / Error / Never connected`
    
- Last synced at
    
- Events ingested (count) – optional
    
- 按鈕：
    
    - Connect / Reconnect
        
    - Trigger full re-import
        
    - Disable
        

這樣你就：

- 保持整個「connector 系統」在 **一個頁面、一張表** 裡管理
    
- 對 user 來說也很清楚：「這些是我允許這個 OS 看的東西」
    

---

## 5. 為什麼不是 n8n-node-style connector？

你自己其實已經有直覺覺得「怪」了，我幫你再用 entropy 語言說一次：

### n8n 節點在做的是：

- 每個節點都夾帶「邏輯 + 轉換」
    
- 數據流是 user 自己畫出來的 graph
    
- Workflow 本身變成 **結構熵最高的一層**
    

在你的世界裡：

- **結構熵** 要集中在 **App + Schema**（由 Architect / Optimizer 共同演化）
    
- connector 應該是一種 **「物理層 driver」**，越 dumb 越好
    

如果讓 connector 會：

- call 某 API → 做過濾 → 做 join → 做 mapping → 打某個 webhook → 寫某個 table
    

那：

- 你又把「結構」分散到各個外部 plugin 裡了
    
- 無法 global analyze / optimize 全系統資料流
    
- 日後根本沒辦法做 entropy management（每個 node 都是一坨黑箱邏輯）
    

**一句話總結：**

> n8n-style node =「把結構熵拆給一堆 plugin 作者」
> 
> 你要的是：**「把結構熵集中在一個可控的 Architect / Optimizer 內核」**。

---

## 6. 再綁回你剛剛那句話

> 外部 source → ingest API → events table  
> 簡單來說用這套一招吃天下 所有東西只吃進 L0  
> 然後可以有個 integration management

這在 high-level design 上已經其實很完整了：

1. **所有 connector 只有一種輸出：RawEvent → `events_l0`**
    
2. **所有 integration 只有一種表示：`integrations` row**
    
3. **所有 sync job 都只有一種 entrypoint：`connector.sync`**
    
4. **所有後續魔法都從 L0 開始，不再塞回 connector 層**
    

---

如果你願意，下一步我可以幫你做：

- 用 **LibSQL schema** + **最小 TypeScript interface**  
    寫一個 _真正可實作_ 的 connector skeleton（例如 `google_calendar.ts` + `events_l0.sql`）
    
- 或者先挑 **ActivityWatch + Calendar** 當第一批 L0 connector，配一個小小 Dashboard，讓你這週末就能看到「我今天實際在幹嘛」的 unified timeline。