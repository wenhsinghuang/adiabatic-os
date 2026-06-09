# 202602140600 Entropy Engineering — Objective Function & Scope

Status: parked philosophy (consolidated 2026-06-10). This is the system's long-term purpose layer, not current work — P0 is cold start; the Optimizer is not on TODO.md. The doc previously carried three stacked revisions (split → merge → re-split); they are consolidated below into the current position plus a changelog.

---

## 系統核心目的

**在持續增長的資料量下維持低 entropy。**

所有現有工具的共同失敗：資料越多越亂。Notion 筆記腐爛、file system 變垃圾場、各工具資料隔離。Adiabatic 反轉這個趨勢：用越久越有序。

不是筆記軟體、不是 app platform、不是 AI assistant。是讓個人資料可持續累積的基礎設施。

OS = infra（D0/D1/D2 + Guard）+ entropy engineering（Optimizer）。兩者合起來構成 self-maintainable low-entropy system。

---

## Current Position: 兩層 Objective

```
Layer 1: minimize E — 管 data substrate 的秩序
Layer 2: maximize U — 在 organized data 上做 domain reasoning，產生 insight / action / 發現盲區

Layer 1 是 Layer 2 的 prerequisite（data 不乾淨什麼都做不了）
Layer 2 的 feedback 校準 Layer 1（什麼該 promote 取決於什麼對人有用）
Layer 2 的關鍵能力：主動發現 unknown unknowns，而非被動回應已知需求
```

### Layer 1: minimize E

```
Objective:   minimize E (structural + semantic + interaction entropy)
Constraint:  Optimizer 不能刪資料，只能 reorganize / promote / merge / restructure
```

三個 entropy proxy（測量方式，可進化；objective 不變）：

```
Structural entropy  → 找得到東西嗎（navigability）
Semantic entropy    → 東西意思明確嗎（clarity）
Interaction entropy → 做事順嗎（efficiency）
```

**為什麼 D（資料量）不進 objective：**

1. D 在 objective 裡會鼓勵無止盡塞資料 — 只要 D 漲得比 E 快，K 就上升。
2. Optimizer 不控制 D — 資料進入由用戶行為和 connector 決定。Optimizer 只能 reorganize。
3. 空系統 degenerate 靠 constraint 解決 — Optimizer 沒有 "delete data" action，不需要 D 來防。

D 的來源（全部是用戶配置的結果）：Guard auto D0 logging、app crons、connectors、用戶直接輸入。Optimizer 可能**建議**增加 D（「接一個 Oura connector」），但執行權在用戶。

`K = D × f(E)` 保留為 health dashboard metric，不是 optimization target。

### Layer 2: maximize U

很多高價值操作不是在降 entropy，而是在產生新的 judgment：

- 根據基因 × 健檢 × 日常記錄調整 schedule
- 觀察飲食 / 睡眠 / 能量 pattern 做出 prescriptive recommendation
- 根據 info flow 對情緒和 attention 的影響，反過來管理 info flow
- 主動發現 unknown unknowns：「你可以通過搜集 A, B, C 實現 X」

這類操作需要 domain knowledge + causal model + prescriptive reasoning，不是 entropy reduction 能覆蓋的。所以是兩個 objective，不是一個。

### Uninstall Test（邊界 = minimize E vs maximize U）

- 卸載 Layer 2（utility reasoning）→ 系統仍維持低 entropy → 仍是 Adiabatic ✓
- 卸載 Layer 1（entropy engineering）→ 系統不再越用越好 → 不是 Adiabatic ✗

### Action Space（合併後保留）

```
一個 Optimizer 概念下的三種 action space：
  1. 結構操作 — merge / promote / de-promote schema
  2. 功能操作 — 建 app / 改 app / 加 shortcut
  3. 介面操作 — 調 context default / 改 page layout / 改 flow
```

App 可以是 Optimizer 的 output artifact。用戶管決策。

---

## Changelog

- **20260214** — 初版：Entropy Engineering（OS 層、content-agnostic、minimize E）與 Utility Intelligence（app 層、content-aware、maximize insight）分離。
- **20260304** — 合併：content-agnostic 不成立（三個 entropy proxy 都需要理解 content）；改善 app 本身就是降 interaction entropy；一個 Optimizer、一個 objective、三種 action space。
- **20260304 再修正** — 合併過度。minimize E 和 maximize U 本質上是兩個 objective（substrate 秩序 vs domain judgment）。回到兩層結構，但理由從 content-agnostic vs content-aware 改為 objective 本質不同。Uninstall test 邊界重新定義為 minimize E vs maximize U。
- **20260610** — 整篇標記 parked：哲學不變，但不是當前 deliverable。P0 = cold start（substrate + connectors + 真實資料）。Optimizer 的第一個務實測試應該是：cold start 之後，用 LLM agent + promote/demote API 跑週期性整理，驗證「越用越有序」是否需要專職 Optimizer 還是 agent 就夠。
