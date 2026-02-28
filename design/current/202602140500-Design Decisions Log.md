# 202602140500 Design Decisions Log

設計過程中做出的重要決定，附理由。方便未來回溯「為什麼這樣設計」。

---

## 20260214 Session

### DD1: D1 doc content 存 DB，不存 file system

**決定：** Page/doc 的 MDX content 存在 LibSQL 的 `docs` table 裡，不是 filesystem 上的 .mdx 檔案。

**理由：**
1. **統一 sync** — Twin-replica（Desktop ↔ Fly.io）只需要一套 sync 機制（LibSQL）。如果 content 在 file，需要 DB sync + file sync 兩套，長期負債。
2. **SQL queryable** — Optimizer 需要跨 doc 搜尋、分析語意。DB 裡一句 SQL 就能做到。File system 需要自建 index（像 Obsidian 的 Dataview plugin 那樣）。
3. **Vector indexing** — Chunks/embeddings table 會 reference doc content。Content 和 derived data 都在 DB 裡 = 一個 source of truth。Content 在 file + derived data 在 DB = 兩個 source of truth，需要持續保持一致。
4. **DB 的缺陷能補**（加一層 Guard API 讓 AI tool 讀寫 doc），**file system 的缺陷補不回來**（沒有 query engine、沒有 vector search、沒有 CRDT sync — 每個都要造一整套系統，補完等於 worse SQLite）。

**Trade-off：** AI tool 不能直接編輯 file。需要通過 Guard API。用 Agent Skills 教 AI 怎麼呼叫。

### DD2: Yjs (CRDT) 用於 D1 doc sync

**決定：** D1 docs 使用 Yjs CRDT 做 twin-replica sync。`docs` table 同時存 `content`（MDX text, queryable）和 `yjs_state`（binary CRDT state, sync 用）。

**理由：**
1. Twin-replica 可能同時修改同一份 doc（desktop 編輯 + Fly.io background process）。Yjs CRDT 自動 merge，永遠不衝突。
2. 未來可擴展到多設備 sync。
3. D1 先只用 `content` 欄位（單 instance 不需要 sync）。加 sync 時啟用 `yjs_state`，schema 不用改。

### DD3: Chunks/embeddings table 用於 vector indexing

**決定：** 新增 `chunks` table，統一 index D1 docs、D0 events、D2 entity schemas 的 vector embeddings。用 sqlite-vec / LibSQL vector extension，不用外部 vector DB。

**理由：**
1. Optimizer 的 semantic analysis（語意熵測量、promote signal 偵測、相似概念辨識）全部需要 vector similarity search。沒有 embeddings，Optimizer 只能做 keyword matching。
2. 留在 SQLite 裡符合 single-DB 哲學。不引入外部 service。
3. 這是 additive change（加新 table），不影響 docs/events schema。D1 可以不做 vector，需要時加表。

### DD4: App sandbox 三層隔離

**決定：** App 通過三層隔離限制 blast radius。

**三層：**
1. **Data isolation** — Guard 檢查 manifest permission，app 只能寫被 grant 的 table。
2. **Build isolation** — 每個 app 獨立 compile。一個 app 壞了不影響其他（React Error Boundary + lazy loading）。
3. **Network isolation** — TBD。可能限制 app 不能 access network（只有 connector 能），也可能允許特定 permission。

**理由：**
- Vibe code 品質不穩定。AI 寫壞一個 app 不應該拖垮整個系統。
- Data isolation 由 Guard 在 runtime enforce。
- Build isolation 讓壞 code 的影響限制在單一 app：compile 失敗 → 該 app 的 component 顯示 error placeholder，其他一切正常。
- Network isolation 的程度還是 open question。

### DD5: Code 在 file system，Data 在 DB

**決定：** App code（components, backend, manifest）存在 file system。Data（D0/D1/D2, chunks, meta）存在 DB。

**理由：**
- Code 需要被 AI tool 直接讀寫、被 compiler 處理、被 git track。File system 是天然選擇。
- Data 需要 query、sync、vector index、audit trail。DB 是天然選擇。
- 對應哲學：「Data is the Asset, Code is the Liability.」Data 受 Guard 保護住在 DB。Code 是可拋的，住在 file system。

**Code sync = deployment（單向，Desktop → Fly.io）。Data sync = LibSQL bidirectional real-time。**

### DD6: Agent Skills format 取代 CLAUDE.md

**決定：** 用 Agent Skills open standard（agentskills.io）取代單一 CLAUDE.md 檔案。

**理由：**
1. **Progressive disclosure** — 不需要整份 conventions 塞進 AI context。建 app 時只載 create-app skill。
2. **AI-tool agnostic** — Agent Skills 是 open standard，Claude Code、Cursor、Gemini CLI、Codex 都支持。不綁特定 AI tool。
3. **可包含 scripts + templates** — `scaffold.sh` 自動建目錄結構，比純文字 conventions 更強。
4. **"App as prompt"** — 分享 app = 分享一個 skill。用戶的 AI tool 在本地生成 code。天然 fit marketplace 設計。

**注意：** CLAUDE.md 仍然可以存在作為 top-level project overview。Skills 處理 specific tasks。

### DD7: D0/D1/D2 三層資料架構確認

**決定：** 維持 D0（raw events）/ D1（live docs）/ D2（structured tables）三層分離。

**理由：**
- 三層對應不同 entropy 級別：D0 最高（raw, noisy）、D1 中等（human-curated, unstructured）、D2 最低（schema-defined）。
- 三層有不同操作特性：D0 append-only、D1 CRDT sync、D2 row-level CRUD。
- 三層的 sync 策略不同：D0 bulk push、D1 Yjs updates、D2 LWW。
- 資料沉澱路徑（D0 → D1 → D2）對應 entropy 遞減。Promote/de-promote 在層間移動概念。
- 如果併為兩層（D0 + D2），D1 的獨特操作語意（CRDT、rich text editing、版本策略）會被混淆。
- D1 的特殊性：它同時是 data（存在 DB）和 interface（用戶直接在 page 裡讀寫）。D0 和 D2 都有 abstraction 隔開用戶（D0 invisible，D2 通過 component），D1 是 data layer 和 view layer 的 bridge。

### DD8: Working tree pattern — DB source of truth + file materialization

**決定：** DB 是 D1 content 的 source of truth。同時提供 `pages/` working tree（materialized .mdx files），讓 AI tool 可以直接讀寫 files。File watcher + Guard event 保持雙向同步。

**理由：**
1. **AI-tool agnostic** — Claude Code、Cursor 等工具天然操作 files。不需要學 API 或 CLI，直接 read/write .mdx。
2. **低複雜度** — 不是真正的 bidirectional sync。單用戶場景下 conflict 幾乎不會發生（dev session 和 editor session 不同時）。核心就是 file watcher + Guard event listener，~100-200 行 code。
3. **不影響 schema** — 純 runtime 層的東西，隨時可以加或移除。DB schema 不需要為此改動。
4. **Git 驗證過的 pattern** — Git 的 source of truth 也在 DB（.git/objects），working tree 是 materialized files。成熟的 pattern。

**機制：**
- DB → Files：Guard 寫了 doc → write file to `pages/`
- Files → DB：file watcher 偵測變更 → `guard.writeDoc()`
- DB 永遠是 source of truth。`pages/` 是 convenience layer。

### DD9: App sandbox — Bun Worker thread（D1），可升級

**決定：** D1 用 Bun Worker thread 做 app backend 的 process isolation。未來可升級到 WebContainers 或其他方案。

**理由：**
1. **夠用** — Single-user desktop app 的 threat model 是「保護用戶不被自己的 buggy vibe code 搞壞」，不是「保護 server 不被惡意用戶攻擊」。Worker thread 提供 process-level isolation，已足夠。
2. **輕量** — 不需要 WebContainers（多一整個 WASM Node.js runtime）或 microVM。
3. **可升級** — Sandbox 策略是 implementation detail，不是 data schema。改了不影響 data。未來 marketplace 有 3rd party app 時可升級隔離方式。