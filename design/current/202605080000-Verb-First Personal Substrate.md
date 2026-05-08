# 202605080000 Verb-First Personal Substrate

Adiabatic OS 的定位不是「更好的 notes app」，而是 **user-owned verb-first substrate**：先保住 raw event log，再把 docs、apps、dashboards、traits、summaries 都視為可替換 projection。

---

## Core Claim

個人系統的 primitive 應該是 event，不是 file。

Obsidian / Notion / Evernote 的基本單位是 noun：note、page、block、database row。這對 knowledge management 夠用，因為知識常常可以被命名、整理、重訪。但 personal memory / self-model 的原料不是名詞，而是動詞：

- 你看了什麼
- 停在哪裡多久
- 跟誰互動
- 哪個主題重複出現
- 什麼情境下做了什麼選擇

這些東西先天是 time-ordered stream。把它們硬塞進 file / note 會失去時間粒度、causality、dwell、sequence，也會逼使用者先命名那些還沒成形的東西。

Adiabatic 的 D0/D1/D2 對應：

- **D0** = raw event stream。append-only，永久 source of truth。
- **D1** = live docs。用戶主動思考的 surface，也是 event source。
- **D2** = derived / promoted state。aggregate、pattern、trait、app table，全都可重算。

---

## Littlebird Learning

Littlebird.ai 是重要 timing signal。它的 FAQ 說它會注意 active window，讀 active applications 的 text and elements，不錄螢幕；也說它看不到 minimized apps、private browser windows、passwords 等 sensitive information。這代表 macOS / Windows desktop context capture 已經可產品化。

對 Adiabatic 的 implication：

- **macOS Accessibility API / AXUIElement** 可以作為第一級 connector：讀 UI hierarchy、focused element、window/app、visible text、selection、actions。
- **不要用 screenshot OCR 當預設路徑**。OCR 太重、隱私風險更高、語意結構更差。AX API 先拿 structured text / elements，OCR 只做 fallback。
- **password / secure field 是第一版安全需求**。即使 Littlebird 宣稱不讀密碼，Adiabatic connector 也要明確處理 secure text fields、private browsing、denylisted apps、pause capture、last-hour delete。
- **差異不在 capture 能不能做，而在 ownership**。Littlebird 的 captured memory 進 SaaS/cloud schema；Adiabatic 的 captured interaction 必須先進使用者擁有的 D0 event log。

第一版 AX event shape 可以很窄：

```json
{
  "schema_version": "0.1",
  "source": "connector:macos-ax",
  "type": "ui.focus.changed",
  "started_at": 1778220000000,
  "payload": {
    "app": "Cursor",
    "bundle_id": "com.todesktop.230313mzl4w4u92",
    "window_title": "adiabatic-os",
    "role": "AXTextArea",
    "text_excerpt": "current visible text, redacted/truncated",
    "selection": null
  }
}
```

Raw event 必須小心 truncate / redact。完整 text 是否保存是 policy，不是 schema invariant。

---

## Evolvability Contract

Substrate 可以早 ship，但只能承諾一個小而硬的核心：**今天 capture 的 raw event，五年後還能讀，還能用新 derive logic 重新投影。**

需要守住幾個 pattern：

1. **Raw and derived are separate.** D0 raw event 永遠不被 D2 derived state 污染。
2. **Raw event has `schema_version`.** 沒 version 就沒有 parser 分流、lazy migration、multi-version coexistence。
3. **Payload stays open.** 不把 source / actor / action universe 寫死成 enum；payload 是 open map。
4. **Derived state carries provenance.** D2 rows / summaries / traits 要知道 derived from 哪些 event，以及 derived by 哪個 logic version。
5. **Escape hatches are explicit.** `payload`, `metadata`, `_experimental_*`, capability negotiation 都是保留未來改動權的工具。

這把 substrate 的壓力從「功能範圍完備」降成「承諾範圍完備」。v0.1 可以只 ship append/read/replay event log；Guard、Optimizer、D2 projections 都能慢慢長。

---

## Positioning vs Nearby Systems

| System | What it proves | Why it is not Adiabatic |
|---|---|---|
| Littlebird | Ambient desktop capture is now socially and technically plausible. | Memory lives in SaaS/cloud schema; AI owns the memory model. |
| Obsidian | Local-first files create real user ownership. | Primitive is file/note, not event; ambient stream is an awkward fit. |
| Stevens | One SQLite table + cron importers + LLM brief can already be useful. | Personal demo; free-text memories avoid schema evolution and integrity problems. |
| Potluck / Dynamic Documents | Text can gradually become interactive personal software. | Works better as an OS feature; does not define the shared event substrate. |
| Bring Your Own Client | Data/client separation is the right power structure. | Leaves the personal substrate shape mostly open. |

The clean claim: **Litt and Ink & Switch named much of the malleable-software direction; Adiabatic’s claim is production-grade substrate with integrity guarantees.** The novelty is not "AI-generated personal tools" by itself. The land claim is D0-first, user-owned, versioned, append-only raw events + Guard + re-derivable projections.

---

## Reading List

Must read:

- [Malleable software in the age of LLMs](https://www.geoffreylitt.com/2023/03/25/llm-end-user-programming.html) — double loop: inner loop direct manipulation, outer loop tool editing with an LLM developer.
- [Stevens: a hackable AI assistant using a single SQLite table and a handful of cron jobs](https://www.geoffreylitt.com/2025/04/12/how-i-made-a-useful-ai-assistant-with-one-sqlite-table-and-a-handful-of-cron-jobs) — closest working demo to the "shared pool of context" idea.
- [Bring Your Own Client](https://www.geoffreylitt.com/2021/03/05/bring-your-own-client) — data/client separation and schema compatibility problems.

Should read:

- [Dynamic documents // LLMs + end-user programming](https://www.geoffreylitt.com/2022/11/23/dynamic-documents) — Potluck and the "works better as an OS feature" clue.
- [Codifying a ChatGPT workflow into a malleable GUI](https://www.geoffreylitt.com/2023/07/25/building-personal-tools-on-the-fly-with-llms) — personal one-off GUI as a real workflow.
- [Enough AI copilots! We need AI HUDs](https://www.geoffreylitt.com/2025/07/27/enough-ai-copilots-we-need-ai-huds) — AI as ambient augmentation, not just task agent.
- [Code like a surgeon](https://www.geoffreylitt.com/2025/10/24/code-like-a-surgeon) — methodology for human-led, AI-assisted implementation.

Primary capture references:

- [Littlebird FAQ](https://littlebird.ai/faq) — active-window capture, text/elements instead of screen recording, private/password exclusion claims.
- [Apple AXUIElement](https://developer.apple.com/documentation/applicationservices/axuielement) — accessibility object model.
- [Apple AXUIElement.h](https://developer.apple.com/documentation/applicationservices/axuielement_h) — observer, attribute, focused/system-wide APIs for macOS accessibility clients.
