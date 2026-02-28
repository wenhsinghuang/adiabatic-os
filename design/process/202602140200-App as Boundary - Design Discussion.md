# 202602140200 App as Boundary — Design Discussion

從 first principles 推導 app abstraction 的必要性和設計。

---

## 1. 為什麼系統需要 Boundary

前提：沒有 boundary 的系統，coupling 會隨時間自然產生。

```
Session 1: Claude Code 寫了 focus-tracker，很乾淨
Session 2: Claude Code 寫了 mood-logger，很乾淨
Session 3: 你說「讓 mood 頁面也顯示 focus data」
           → mood-logger 裡 import 了 focus-tracker 的 component → 耦合產生
Session 4: 你說「改一下 focus-tracker 的 data format」
           → mood-logger 壞了
```

每個 session 都守規矩，但累積效應產生 coupling。不是 AI 笨，是系統複雜度的本質。

Convention without enforcement 會 decay — 即使 AI 每次都讀 CLAUDE.md，跨多次 session 的累積效應沒有全局視角可以防。

事後拆 boundary 的成本遠高於一開始就設（monolith → microservice 的教訓）。

**結論：D1 就要有 boundary。**

---

## 2. 為什麼 App 是好的 Boundary Unit

Boundary 的目的 = 限制 coupling 的擴散。好的 boundary 要滿足：

1. **內聚性高** — boundary 內的東西確實互相需要
2. **耦合點少** — boundary 之間的接觸面盡量小
3. **可獨立演化** — 改 boundary 內的東西不影響外面
4. **語意完整** — boundary 對應到一個人類能理解的概念

各種 boundary granularity 的比較：

| Boundary | 內聚性 | 耦合點 | 可獨立演化 | 語意完整 | 結論 |
|----------|--------|--------|-----------|---------|------|
| File-level | ❌ 功能跨多 file | ❌ 多 | ❌ | ❌ file ≠ 概念 | 太細 |
| Table-level | ❌ 功能需多張表 | ❌ 多 | ❌ 改表連動 | ❌ | 太細 |
| **App-level** | ✅ component+table+backend 互相需要 | ✅ 只通過 read shared tables | ✅ | ✅ 對應一個功能意圖 | **剛好** |
| Monolith | 太高 | ❌ 什麼都 depend | ❌ | ✅ 但太粗 | 太粗 |

**App 是 sweet spot 因為它對應到「一個功能意圖」。** Focus tracking 是一個意圖，mood logging 是另一個意圖。每個意圖自然包含一組 tables + components + backend logic。App align with 人類的認知單位。

---

## 3. App 的定義

```
App = 一個 self-contained 的功能意圖
├── Manifest (manifest.json)  ← boundary 的牆：宣告需要什麼、能碰什麼
├── Components (React)        ← view layer，可被任何 page 引用
├── Backend (crons, routes, ETL) ← 邏輯層
├── Migrations                ← D2 schema setup
└── Pages (MDX templates)     ← 預設的 view
```

App 的本質不是「功能模組」，是 **permission boundary + entropy management tool**。

---

## 4. Data Ownership Model

所有 table 歸 system 所有，不歸 app。System grant write permission 給 specific app。

```
System (owns all tables)
├── focus_sessions  → granted write to: focus-tracker
├── mood_logs       → granted write to: mood-logger
├── tasks           → granted write to: task-app, daily-planner
└── events          → granted write to: all (D0, append-only)

所有 app 都能 read 所有 table（universal read）
Write 需要 system grant（via manifest 宣告）
Guard enforce permissions at runtime
```

好處：
- **Merge** 不需要 ownership 轉移（table 本來就是 system 的）
- **多 app 可 write 同一張表**（system 可以 grant 給多個 app）
- **App 卸載**：撤銷 grant，table 和 data 不動
- **App 安裝**：system 建表（或發現已有）+ grant write permission

---

## 5. App 與 Entropy Framework 的關係

App boundary 是 code 層面的 entropy management：

```
App boundary     → 控制 structural entropy（code coupling）
D2 table schema  → 控制 semantic entropy（data 清晰度）
Guard            → enforcement point
Optimizer        → 跨 boundary 的 merge / de-promote 建議
```

Promote / De-promote / Merge 也發生在 app 層面：
- 用戶在 doc 裡反覆提到某個功能 → Optimizer 建議 promote 成 app
- 一個 app 長期沒用 → 建議 de-promote（卸載 app，data 保留）
- 兩個 app 功能重疊 → 建議 merge

---

## 6. App Lifecycle

**安裝（Install）：**
1. 跑 migration（建表，或發現已有表 → mapping）
2. 註冊 components（可被 page 引用）
3. 註冊 backend jobs（crons 開始跑）
4. System grant write permissions

**卸載（Uninstall）：**
1. 停 backend jobs
2. 移除 components（page 裡的引用顯示 placeholder）
3. 撤銷 write grants
4. **Tables 和 data 保留**（Data is the Asset）

**卸載後重裝不同的 app → 讀同一份 data。App 可以死，data 不會死。**

---

## 7. Sharing & Marketplace

App 是可分享的 atomic unit：Code + Manifest。

分享方式：
- **Code package**：完整 code（經 marketplace 審核：static scan + AI + community）
- **App as prompt**：只分享 spec，用戶的 Claude Code 在本地生成（零安全風險，天然適配）
- **Hybrid**：同時提供 code + spec，用戶可選擇直接裝或用 spec 客製

安裝第三方 app 時，sandbox 提供 security isolation（Day 1 的 boundary 自然支持這個）。

---

## 8. OS vs App 分離

Syntropy runtime (@syntropy/core) 是 npm package，用戶不碰：

```
syntropy/
├── node_modules/@syntropy/core/  ← OS（protected）
│   ├── guard.ts
│   ├── db.ts
│   ├── server.ts
│   └── sync.ts
├── CLAUDE.md                      ← conventions
├── apps/                          ← App code（Claude Code 活動範圍）
│   ├── focus-tracker/
│   └── mood-logger/
├── pages/                         ← MDX
└── data/syntropy.db
```

三層 isolation：
1. **OS 層**：@syntropy/core，用戶完全不碰
2. **App 層**：每個 app 有自己的 sandbox（manifest enforce by Guard）
3. **Data 層**：system owns all tables，app 只有被 grant 的 write permission

---

## 9. 三種 App 形態

```
1. Full-stack app（有 schema + component + backend）
   例：focus-tracker — 有 focus_sessions 表、FocusChart 組件、sync cron

2. View-only app（只讀，不建表）
   例：sleep-dashboard — 讀 Oura data，只提供 SleepSummary 組件

3. Backend-only app（沒有 UI）
   例：daily-digest — 讀各種表，cron 生成 summary 寫進 D1 doc
```

---

## 10. 品質保護（三層 defense）

```
Layer 1: App sandbox        ← 限制 blast radius（寫錯地方）
Layer 2: Guard validation   ← 限制 bad writes（寫錯東西）
         - Schema validation
         - Anomaly detection
         - Constraint check
Layer 3: D0 audit trail     ← 出事能復原
         - 每筆 write 都記錄
         - Rollback 到任意時間點
```

App sandbox 防「寫錯 table」，Guard validation 防「寫錯 data」，D0 防「事後追不回來」。三者互補。

---

## Open Questions

- Manifest 的具體 spec 還需要細化
- App 之間 component 引用的規則（page 可以自由 compose，但 app code 之間呢？）
- App 的 versioning / update mechanism
- Optimizer 怎麼跨 app boundary 做 merge 建議
