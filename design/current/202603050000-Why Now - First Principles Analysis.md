# 202603050000 Why Now — First Principles Analysis

為什麼 Adiabatic OS 這個方向現在才可能成立。

---

## 歷史上大家在解決什麼問題

一句話：**人累積的資訊越來越多，但從中獲得價值的能力沒有等比增長。**

拆開來看，這個問題有四層：

| 層 | 問題 | 歷史解法 |
|---|------|---------|
| Capture | 資料怎麼進來 | 都解了。打字、API、import，不是瓶頸 |
| Organization | 進來之後怎麼放 | 手動：folder、tag、link、canvas。全部 scale 不了 |
| Retrieval | 要用的時候找得到嗎 | Search、backlink、Dataview。勉強能用但被 organization 的品質限制 |
| Synthesis | 能從已有資料產生新 insight 嗎 | 幾乎沒有工具解這個。全靠人腦 |

每一代工具都在不同層上努力：

- **Emacs/Org-mode** — 強在 capture + organization，但手動成本太高
- **Roam/Obsidian** — 強在 retrieval（backlink 讓你少依賴 organization），但 organization 問題只是被 defer 了，沒被解
- **Notion/Tana** — 強在 organization（database view, supertag），但 synthesis 做不了，而且 organization 還是手動
- **Heptabase** — 試圖用 spatial layout 做 synthesis，但 synthesis 還是靠人的視覺皮層，scale 不了

核心矛盾：**Organization 的成本隨資料量線性（甚至超線性）增長，而人的時間是固定的。** 所以每個系統最終都會到達一個點 — 資料量超過人能維護的上限，entropy 開始贏。

這不是功能問題，是經濟學問題。Organize 的勞動力供給不足。

---

## AI 的 Paradigm Shift

不是「AI 能幫你寫筆記」或「AI 能幫你搜尋」。這些是表面。

根本性的改變是：**Organization 和 Synthesis 的邊際成本趨近於零。**

以前：
- 把一筆 Oura 睡眠資料歸類到對的地方 → 人力
- 發現睡眠跟飲食的 correlation → 人力
- 為這個 correlation 建一個 dashboard → 開發者人力

現在：
- Organization → AI batch process，成本跟資料量幾乎無關
- Synthesis → AI cross-domain reasoning，人不需要自己想到要問什麼
- 建 app → AI 寫 code，幾秒鐘

核心矛盾消失了。Organization 的成本不再隨資料量增長。第一次有可能建一個 entropy 不隨時間增長的系統。

但這有一個前提條件：**AI 必須能 access 所有資料、能 restructure、能建工具、而且有安全邊界。**

這個前提條件就是 Adiabatic OS 在建的東西。

---

## 設計的核心原則：No Abstraction

Adiabatic OS 的每一層都是 AI 已經熟悉的 primitive：

- **SQL** — AI 訓練資料裡最多的 query language
- **React/JSX** — AI 最熟的 UI framework
- **MDX** — markdown + JSX，兩個 AI 都會的東西
- **File system** — AI tool 天生就是讀寫 file
- **REST API** — 最基本的 HTTP call

沒有 custom query language（Dataview, TiddlyWiki filter），沒有 proprietary block protocol（Notion API），沒有 graph traversal syntax（Roam/Tana），沒有需要學的 plugin API（Obsidian/VS Code extension）。

CLAUDE.md 之所以那麼短就能 work，是因為它不需要教 AI 新東西。只需要告訴 AI：「你已經會的那些東西，在這個系統裡的入口在哪。」

**這是核心的範式轉移：以前設計抽象層是為了降低人的認知負擔。但現在系統的主要操作者是 AI，而 AI 處理 raw primitive 比處理自定義抽象更準確。** 你包的每一層抽象，對 AI 來說都是多學一樣東西、多一個出錯的機會。

系統的表達力不來自抽象的複雜度，而來自 primitive 的組合自由度。SQL 能 query 任何結構的資料，React 能 render 任何 UI，MDX 能把兩者黏在一起。AI 全都會。

不要發明東西，讓 AI 用它已經會的東西。

No abstraction 同時帶來兩個結果：

1. **最強的表達力** — SQL + React 幾乎沒有天花板。以前表達力最強的工具（Emacs, Smalltalk）使用門檻最高，最簡單的工具（Notion, Apple Notes）表達力最低。現在兩者同時成立，因為複雜度不是被抽象層藏起來，而是被 AI 吸收了。
2. **Disposability by design** — 任何一個部件都可以被 AI 重寫而不影響其他部件。App 壞了重寫，data 不受影響。Page 不好看重寫，app 不用改。這不是一般意義的模組化，而是每一層都可拋，除了 data。因為抽象層本身就是耦合 — 不包抽象，app 之間零耦合，跟系統只透過 Guard 這一個 contract 耦合。

---

## Vendor Lock-in 的新意義

以前 vendor lock-in 的代價是抽象的 — 「資料在別人手上」聽起來嚴重但日常感受不到。

現在不一樣了。**Lock-in 的痛不再是「搬家很麻煩」，而是「AI 的能力被 vendor 的邊界截斷」。**

- Claude.ai 累積了半年的 memory，想換 GPT → 帶不走
- Notion 裡的資料，想讓 Claude Code 操作 → API 限制，做不到
- 想跨 AI provider 用同一份資料 → 每家格式不同

AI 越強，你想讓它做的事越多，撞到邊界的頻率越高。這個痛會持續加劇。

Adiabatic OS 的定位：**人 + data 是核心，AI 是可替換的勞動力。** Guard 不在乎 write 是 Claude、GPT、Gemini 還是人發起的，全部走同一條路。換 AI = 換一個工人，data 不動。

---

## 根本的 Value Proposition

有 organization + synthesis 的 data 累積 = **external cognition 的成長**。

人的大腦容量是固定的，但 D0 是 append-only 的。如果 Optimizer 能持續把累積的 data 變成 queryable、synthesizable 的 knowledge，人的認知能力就不再受大腦限制。

「越用越有序」是手段。External cognition 的持續成長才是目的。

這也解釋了為什麼 data ownership 不是理想主義 — 你的 external cognition 存在別人的 server 上，那它是你的能力還是他們的？

---

## Guard 的設計原則

**系統級的安全邊界不應該依賴 app 的自律。**

Guard 管 write permission 和 Guard 管 secret 是同一件事 — app 能做什麼不是 app 自己決定的，是 Guard 決定的。這才是 OS 該做的事。

對比 Obsidian plugin 的安全模型：完全依賴 plugin 作者的自律。任何 plugin 都能讀整個 vault、發 network request、存任何東西到任何地方。Plugin 越多，implicit 的 data model 和 coupling 越多，任何改動都可能踩到某個 plugin 的隱性假設。

Adiabatic OS 的 app 不寄生在 host 的 data model 上 — 它透過 Guard 讀寫 DB，DB 是唯一的 source of truth。App 之間不需要協調，因為它們都看同一份資料、走同一個 write path。Data model 是 explicit 的（`CREATE TABLE`），不是埋在 code 的 parsing logic 裡。

Guard 的存在本質上是 **不信任 AI 寫的 code**。AI 越強，生成的 app 越多，你越不可能一個一個 review。你需要一個機制讓你不用 review 也不會出事。不管 AI 寫了什麼垃圾 code，它最多只能寫到 manifest 宣告的 table，每筆 write 都有 D0 記錄，secret 拿不到真正的 value。

**信任 AI 的能力，但不信任 AI 的行為。Guard 就是這個矛盾的解法。**
