# 202602140500 Design Decisions Log

Status: canon, append-only log. Old entries are never rewritten; corrections arrive as newer dated entries. See the 20260610 Status Review at the bottom for which DDs are alive, dead, or deferred.

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

---

## 20260304 Session

### DD10: Flow editor 是 built-in primitive，Canvas 不內建

**決定：** Flow-based MDX editor 是系統內建的 first-class 編輯器。Canvas（空間佈局）不內建，若需要可通過 app 實現。

**理由：**

**為什麼 flow 是 primitive：**
- 語言本身是 sequential 的。人一次只能讀一個字，論述有因果順序。這不是習慣，是語言的物理限制。
- Flow 負責「表達思想」（sequential，不可壓縮），spatial 負責「組織思想之間的關係」（parallel，可一眼掃過）。
- 沒有內容就沒有東西可以組織 — flow 比 spatial 更 fundamental。
- 所有工具（Heptabase、Notion、Obsidian）的 canvas 最終都指向 card/document — 一個 flow-based 的編輯單元。Card 是不可再分的原子。

**為什麼 flow editor 是 built-in 而不是 app：**
- **Bootstrapping** — 要有 app，先要有 page 放 `<App />`；要有 page，先要有 MDX editor。Flow editor 是 layer 0。
- 類似 OS 的 shell/terminal — 也是一種 view，但是 built-in 的，因為沒有它連 app 都裝不了。
- 理論上未來 app 系統夠強時，MDX editor 也可以變成可替換的 app。但現階段是 bootstrap 必需品。

**為什麼 canvas 不內建：**
- Canvas 是一種 view，不是 data model。「空間座標作為資料是污染」（design philosophy）。
- Heptabase 的教訓：把 x/y 座標寫進資料，導致資料被 canvas view 綁架。
- Canvas app 可以自己管理 spatial layout（座標存在 app 的 ephemeral state），從 D1/D2 讀資料投射成空間佈局，完全不污染資料。
- Canvas 的複雜度（zoom、pan、connection lines、layout algorithm）封裝在 app 裡，不用改核心。
- 不喜歡某個 canvas 實現？換一個 app 就好。符合「Code is the Liability」。

**結論：** Flow editor = built-in primitive。Canvas = app use case。架構已為此留好位置。

### DD11: MDX 是所有 content 操作的 single source of truth

**決定：** 所有對 page content 的操作（排版、拖拽排序、resize、樣式變更）本質上都是 MDX 的改動。Editor 是 MDX 的 WYSIWYG view，不維護額外的 side state。

**理由：**
1. **One interface, all actors** — 用戶在 editor UI 操作、用戶手寫 MDX source、AI agent 直接編輯 .mdx 檔案，三者的效果完全等價。不需要為不同 actor 提供不同 API。
2. **No hidden state** — 沒有 CSS-only 的 ephemeral state（刷新就丟失），沒有 editor-only 的 metadata store。所有可見的狀態都能在 .mdx 裡找到對應的文字。
3. **Plain text = universal interface** — MDX 就是 plain text。任何 tool（AI agent、script、version control）都能讀寫，不需要了解 editor internal。
4. **Serialization round-trip 已建立** — Plate node ↔ MDAST ↔ MDX text 的雙向轉換已完整。新操作只需在這個 pipeline 上擴展，不需要新機制。

**應用範例：**
- Component resize → 序列化為 `<Component data-width="500px" data-height="300px" />` 寫入 .mdx
- DnD 拖拽排序 → block 在 .mdx 中的順序改變
- 任何 visual property 的改動 → 對應到 .mdx 中某個 JSX/Markdown 結構的變化

**邊界：** 這個原則只適用於 **content**（page 內容）。Application layout（sidebar width、terminal height）屬於 shell UI state，不存在 MDX 裡。

---

## 20260512 Session

### DD12: Editor 全面簡化 — 砍掉 WYSIWYG，換 off-the-shelf markdown editor

**決定：** 刪除 Obsidian-style MDX WYSIWYG editor 全部實作（commit `e2c34b8`：`MdxRenderer.tsx` 935 行、`editor-ops.ts` + 491 行測試、`SlashPalette`、`InlineBlockEditor`、`mdx-parser.ts`，共約 2,400 行）。換成 `MarkdownPageEditor`（185 行，wrap `@mdxeditor/editor`）+ `markdown-normalize.ts`（48 行）。

**理由：**
1. **ROI 太小。** 花在 editor 的時間不推進 P0（cold start）。Editor 是最 disposable 的一層（D1 projection 的 view），卻吃掉最多 effort。
2. **主要 author 是 AI。** 系統哲學說 AI 操作 raw MDX text 最準確；複雜的人類 WYSIWYG ergonomics 跟這個前提矛盾。人要寫字，一個夠用的 markdown editor 就夠。
3. **買比造好。** `@mdxeditor/editor` 是維護中的 library，markdown 編輯不是這個專案的差異化所在。

**連帶效果：**
- **In-page component rendering 移除。** Shell 沒有 MDX compile path。Page 裡的 `import` / JSX / raw HTML 由 `inertUnsupportedMdx()` 包成 ` ```mdx ` code fence，以 inert source code 顯示，不執行。App 在獨立的 `AppRuntimeView` tab 跑。
- **「Pages compose Apps」（DD11 前提、5-Layer doc 的 key insight）→ deferred。** 不是放棄 claim，是 editor ROI 太小、不是當前 focus。Substrate 不依賴 composition，cold start 之後再評估。
- **已知行為：normalize 是單向的。** `inertUnsupportedMdx` 在載入時包 fence，save 時不會解包 — 編輯過的 legacy MDX page 會把 fence 持久化進 doc content。這視為 intentional migration（JSX in pages = legacy，凍結成可見 code）。若 composition 回歸，需要 migration 處理這批 page。

**推翻 / 修正了什麼：**
- DD10（flow editor 是 built-in primitive）— 方向保留（還是有 built-in editor），但「WYSIWYG MDX editor 是 layer 0 必需品」的版本推翻。Markdown editor 就夠 bootstrap。
- DD11（MDX 是所有 content 操作的 single source of truth）— 原則仍成立（content = plain text，無 hidden state），但適用面縮小：editor 不再做 component resize / DnD 序列化，因為 component 不再 render。

## 20260610 Status Review

對既有 DD 的狀態盤點（append-only，不改寫原 entry）：

| DD | 狀態 | 說明 |
|----|------|------|
| DD1 (content 存 DB) | ✅ 成立 | DD8 working tree 補上 file 入口 |
| DD2 (Yjs CRDT sync) | ⏸ deferred | 無限期。Local-first 單 instance；working tree 用 LWW |
| DD3 (chunks/embeddings) | ⏸ deferred | 被 Retrieval Memory Module Requirements 重新定位：retrieval 是 replaceable derived layer，embedding 只是一種實作 |
| DD4 (app 三層隔離) | ✅ 部分成立 | Data isolation 由 Guard enforce ✓。注意：connector 走相反路線 — hash trust + human approval，不 sandbox（見 Connector Runtime Module） |
| DD5 (code 在 FS, data 在 DB) | ✅ 成立 | |
| DD6 (Agent Skills 取代 CLAUDE.md) | ❌ dead | 沒實作也不打算。`core/src/claude-md.ts` 生成 CLAUDE.md 就是現行機制 |
| DD7 (D0/D1/D2 三層) | ✅ 成立 | 核心 invariant，由 Verb-First doc 強化 |
| DD8 (working tree pattern) | ✅ 成立 | 已實作（`working-tree.ts`） |
| DD9 (Bun Worker sandbox) | ⚠️ 演化 | App 實際走 WebContainer bridge + capability token（見 Local Capability Auth）；per-app hard isolation 仍是 future work |
| DD10 (flow editor built-in) | ⚠️ 修正 | 見 DD12 |
| DD11 (MDX single source of truth) | ⚠️ 縮小 | 見 DD12 |
