# 202602140330 Adiabatic OS — Open Questions

設計過程中浮現但尚未解決的問題。

---

## Entropy Engineering 支持度

### Q1: Interaction entropy 的 D0 signal 定義

Interaction entropy 需要量化 friction（完成一件事幾步、花多久）和 uncertainty（同一 outcome 有幾條路徑）。D0 schema 技術上能收 UI event，但沒有明確定義哪些 event 要進 D0。

需要回答：
- 哪些 UI event 必須進 D0？（page_view, navigation, component_interaction, time_on_page...）
- 粒度到哪裡？每次 click？還是 intent-level（開始做某件事 → 完成）？
- 怎麼避免 D0 被 UI event 灌爆？

### Q2: Promote / De-promote / Merge 是否需要 system primitive

目前這三個操作全靠 Optimizer 出建議 → Claude Code 手動寫 migration。每次都是 custom work。

如果這是 entropy engineering 的核心操作，可能應該是 `@adiabatic/core` 的 first-class API：

```
system.promote({ concept, source, schema, assign_to_app })
system.demote({ table, archive_strategy })
system.merge({ source_tables, target_table, mapping })
```

好處：deterministic、可回滾、Optimizer 輸出直接可執行。
代價：OS kernel 複雜度上升、需要預先定義操作語意。

需要回答：
- 值不值得在 D1 就做？還是先讓 Claude Code 手動跑，累積 pattern 後再抽象？
- Promote 的完整 lifecycle 是什麼？（建表 → entities row → grant permission → Guard recognize → D0 log）
- De-promote 是 drop table 還是 archive？data 怎麼處理？

### Q3: 歷史 entropy 趨勢的儲存

Optimizer 需要比較「這個月 vs 上個月」的 entropy。目前沒有存 snapshot 的地方。

選項：
- 新增 `entropy_snapshots` 系統表（Optimizer 定期寫入）
- 只算 delta（每次 Optimizer 跑完寫一筆 D0 event with entropy scores）
- 不存，每次從 raw data 重算（costly but simple）

---

## App 設計

### Q4: Manifest 的具體 spec

Manifest 需要宣告什麼？目前知道的：
- App ID + name
- Required tables（write permissions）
- Entry component（for UI）
- Backend jobs（crons, routes）

還需要想：
- Version / compatibility
- Dependencies on other apps?（或者完全禁止 app 間 dependency？）
- Resource limits?

### Q5: App 之間 component 引用的規則

Page 可以自由 compose 任何 app 的 component（這是 Pages 層的設計）。但 app code 之間呢？

- App A 的 backend 能不能 import App B 的 utility function？
- 如果完全禁止 → 可能導致 code duplication
- 如果允許 → coupling 從 page 層滲入 app 層
- 折衷：shared utilities 放在 system level？

### Q6: App versioning / update mechanism

- App 更新時怎麼處理 schema migration？
- 如果 D2 table schema 變了，舊 data 怎麼 migrate？
- Rollback 機制？

### Q7: Optimizer 怎麼跨 app boundary 做 merge 建議

兩個 app 功能重疊時，Optimizer 建議 merge。但 merge 意味著：
- 合併 D2 tables
- 合併 backend logic
- 合併 components
- 更新 page 引用

這比 table-level merge 複雜得多。需要什麼 signal 才能偵測到「這兩個 app 該合併」？

### Q9: App-to-App Event Bus

App 之間零耦合，但跨 app workflow 是日常需求：

```
focus-tracker 偵測連續工作 2hr → 觸發 mood-logger 跳出提醒
daily-digest cron 完成 → 通知 page 更新
```

目前沒有 app-to-app communication 機制。

可能的方向：
- D0 event bus — App A 寫 event，App B 訂閱特定 event kind。Guard 是中間人，app 之間仍然零 code coupling。
- 需要設計：訂閱機制（manifest 宣告 subscribes_to?）、delivery guarantee、避免 event storm。

### Q10: Reactive Layer（DB change → UI re-render）

Page 裡的 component 怎麼知道 data 變了要 re-render？

初步方向：Guard 寫完 DB 後 emit change event → WebSocket 推給 Tauri webview → TanStack Query invalidation → component refetch + re-render。

需要設計：
- Guard emit 的 event 格式（table + row id? 還是更粗粒度？）
- Subscription 機制（component 訂閱哪些 table 的 change？）
- Fly.io replica 的 change 怎麼推到 desktop？（sync 層 vs reactive 層是否共用 channel？）

---

## Code 演化追蹤

### Q8: Git → D0 的具體設計

討論過 git 作為 connector、post-commit hook 寫 D0。但：
- 記什麼？commit message? diff summary? affected files?
- CLAUDE.md 指示 Claude Code log intent — 這個 intent 的格式是什麼？
- Vibe coding 過程（對話 + code change）怎麼關聯起來？
