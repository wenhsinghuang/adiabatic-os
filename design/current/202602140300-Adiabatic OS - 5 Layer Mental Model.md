# 202602140300 Adiabatic OS — 5-Layer Mental Model

整個系統的 mental model，由上到下五層。

---

## The Model

```
┌────────────────────────────────────────────────────────────────┐
│                                                                │
│  Pages (MDX)                                    ← View Layer   │
│  ┌──────┐ ┌──────┐ ┌──────┐ ┌──────┐                          │
│  │ Home │ │Weekly│ │Tasks │ │Journl│                           │
│  │text +│ │text +│ │pure  │ │pure  │   view / source 切換      │
│  │comps │ │comps │ │comp  │ │text  │   任何 page 可引用         │
│  └──┬───┘ └──┬───┘ └──┬───┘ └──────┘   任何 app 的 component   │
│     │        │        │                                        │
│─────┼────────┼────────┼────────────────────────────────────────│
│     ▼        ▼        ▼                                        │
│  Apps (Sandboxed)                            ← Boundary Layer  │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐            │
│  │focus-tracker │  │mood-logger  │  │daily-digest │            │
│  │ components   │  │ components  │  │ (no UI)     │            │
│  │ crons        │  │ routes      │  │ cron        │            │
│  │ ETL          │  │             │  │             │            │
│  │ manifest.json│  │ manifest.json│  │ manifest.json│            │
│  └──────┬──────┘  └──────┬──────┘  └──────┬──────┘            │
│         │ write:          │ write:          │ write:             │
│         │ focus_sessions  │ mood_logs       │ daily_summaries    │
│─────────┼─────────────────┼─────────────────┼──────────────────│
│         ▼                 ▼                 ▼                  │
│  Guard                                      ← Enforcement      │
│  ┌────────────────────────────────────────────────────────┐    │
│  │  manifest permission check                              │    │
│  │  schema validation                                      │    │
│  │  auto D0 event logging                                  │    │
│  └────────────────────────┬───────────────────────────────┘    │
│                           │                                    │
│───────────────────────────┼────────────────────────────────────│
│                           ▼                                    │
│  Data Layer (LibSQL)                          ← The Asset      │
│  ┌────────────────────────────────────────────────────────┐    │
│  │  D0: events (append-only)     ← 發生了什麼              │    │
│  │  D1: docs (MDX content)       ← 你寫了什麼              │    │
│  │  D2: tables (structured)      ← 整理好的資料            │    │
│  │                                                         │    │
│  │  System owns ALL tables. Apps get granted access.       │    │
│  │  Universal read. Scoped write.                          │    │
│  └────────────────────────────────────────────────────────┘    │
│                                                                │
│  @adiabatic/core (OS kernel)                   ← Protected      │
│  Guard · DB · Server · Sync · Optimizer                        │
│  用戶不碰，npm package                                         │
│                                                                │
└────────────────────────────────────────────────────────────────┘
```

---

## 五層職責

| Layer | 職責 | 持久性 |
|-------|------|--------|
| **Pages** | 用戶看到的。MDX，compose 任何 app 的 component。 | 可拋的 |
| **Apps** | 功能意圖的 boundary。sandboxed，各跑各的。 | 可拋的 |
| **Guard** | 唯一的 enforcement point。permission + validation + D0 logging。 | 系統級 |
| **Data** | 唯一的 asset。D0/D1/D2。system owns，app 只是被 grant access。 | 永久的 |
| **OS kernel** | 不可碰的 runtime。Guard/DB/Server/Sync/Optimizer。 | 永久的 |

**由上往下：越來越持久。由下往上：越來越可拋。**

一句話版本：

> **Pages compose Apps, Apps go through Guard, Guard protects Data, Data sits on OS.**

---

## 層間關係

**Pages → Apps：** Page 可以自由引用任何 app 的 component。一個 page 裡可以放 focus-tracker 的圖表 + mood-logger 的趨勢線 + 純文字。Page 是 composition layer — 跨 app boundary 的唯一合法場所。

**Apps → Guard：** App 的所有 DB write 必須經過 Guard。Guard 根據 manifest 檢查：這個 app 有沒有被 grant 寫這張 table 的權限？Schema 對不對？通過了才寫入，同時自動記 D0 event。

**Guard → Data：** Guard 是 data 的唯一入口。沒有任何 code 可以繞過 Guard 直接寫 DB。這保證了 D0 audit trail 的完整性 — 每一筆變更都有紀錄。

**Data → OS kernel：** Data 坐在 OS 提供的 LibSQL 上。OS 負責 DB lifecycle、sync、backup。用戶看不到也碰不到這層。

---

## Twin-Replica 部署

同一份 runtime 跑在兩個地方：

```
Desktop (Tauri)                    Fly.io
├─ 同一份 runtime                  ├─ 同一份 runtime
├─ + UI shell (editor)             ├─ + always-on (24/7)
├─ + local LibSQL                  ├─ + sync endpoint
└─ offline capable                 └─ + Litestream → R2 backup

         ◄──────── sync ────────►
```

Desktop 不是 thin client — 完整 runtime，離線可用。Fly.io 不是 server — 只是你的 runtime 的另一個 always-on instance。

---

## 擴展方式

```
Terminal → Claude Code / Codex → 讀 CLAUDE.md → 寫 app code
```

用戶不碰 OS kernel。用戶在 apps/ 裡開發。CLAUDE.md 告訴 AI 怎麼跟系統互動。

---

## Key Insight: Pages 的組合能力

Pages 是跨 app boundary 的唯一合法場所。App 之間不直接 import 彼此的 code — 這會造成耦合。但 page 可以自由引用任何 app 的 component：

```mdx
# Weekly Review

## Focus
<FocusChart period="week" />     ← from focus-tracker app

## Mood
<MoodTrend period="week" />     ← from mood-logger app

## Summary
This week I focused 32 hours, mood averaged 7.2/10...
```

這讓用戶可以在 view layer 自由組合，而 app layer 維持完全隔離。MDX page 是「黏合劑」— 把各 app 的 output 黏在一起呈現，但 app 之間零耦合。

這個設計我們沒有在其他系統上看過。Notion 的 page 只能 embed Notion block。VS Code 的 extension 不能自由 compose。Adiabatic 的 page 是真正的 universal composition surface。




### Pages layer

MDX + component registry + mdx-bundler + reactive SQL query
    sidebar = file tree
    其他一切 = app