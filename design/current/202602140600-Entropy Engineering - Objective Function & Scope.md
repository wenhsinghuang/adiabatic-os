# 202602140600 Entropy Engineering — Objective Function & Scope

Optimizer 的 objective function 設計，以及 Entropy Engineering 和 Utility Intelligence 的邊界。

---

## 系統核心目的

**在持續增長的資料量下維持低 entropy。**

所有現有工具的共同失敗：資料越多越亂。Notion 筆記腐爛、file system 變垃圾場、各工具資料隔離。Adiabatic 反轉這個趨勢：用越久越有序。

不是筆記軟體、不是 app platform、不是 AI assistant。是讓個人資料可持續累積的基礎設施。

OS = infra（D0/D1/D2 + Guard）+ entropy engineering（Optimizer）。兩者合起來構成 self-maintainable low-entropy system。

---

## Optimizer Objective Function

### 結論：minimize E，D 不進 objective

```
Objective:   minimize E (structural + semantic + interaction entropy)
Constraint:  Optimizer 不能刪資料，只能 reorganize / promote / merge / restructure
```

### 為什麼 D 不進 objective

曾考慮 K = D × f(E)（usable knowledge = 資料量 × 組織品質）作為 objective。放棄原因：

1. **D 在 objective 裡會鼓勵無止盡塞資料** — 只要 D 漲得比 E 快，K 就上升。entropy 的懲罰不夠大時，系統會傾向「先塞再說」。
2. **Optimizer 不控制 D** — 資料進入系統是用戶行為和 connector 決定的。Optimizer 只能 reorganize。
3. **空系統 degenerate 靠 constraint 解決** — Optimizer 沒有 "delete data" action，不可能 degenerate 到空系統。不需要 D 來防。

### D 的來源（Optimizer 不控制）

D 的增長由以下決定，全部是用戶配置的結果：

- **Guard auto D0 logging** — 每筆 write 自動產生 D0 event（寫死在 Guard 設計裡）
- **App crons** — 例如 daily-digest 定期生成 summary（用戶裝了 app）
- **Connectors** — 持續拉外部資料進來（用戶配置）
- **用戶直接輸入** — 寫 doc、記筆記

Optimizer 可能**建議**增加 D（「你應該接一個 Oura connector」），但執行權在用戶。

### Health Dashboard Metric（非 optimization target）

```
K = D × f(E)
```

K 用來在 dashboard 顯示系統健康度，不是 Optimizer 的 optimization target。

### 三個 Entropy Proxy

```
Structural entropy  → 找得到東西嗎（navigability）
Semantic entropy    → 東西意思明確嗎（clarity）
Interaction entropy → 做事順嗎（efficiency）
```

這三個是 E 的測量方式（proxy），不是 objective function 本身。Proxy 可以進化（加維度、改權重），objective（minimize E）不變。

---

## Entropy Engineering vs Utility Intelligence

### 為什麼要分開

| | Entropy Engineering | Utility Intelligence |
|---|---|---|
| **層級** | OS（不可移除） | App（可替換） |
| **Objective** | minimize E | maximize user insight |
| **Content-aware?** | No（content-agnostic） | Yes（domain-specific） |
| **操作** | reorganize, promote, merge, restructure | 讀 data, 產出 insight/view |
| **修改結構？** | Yes（schema, permission, D0/D1/D2） | No（只讀） |
| **Generalizability** | 可用於任何 data system | Personal, opinionated |

### Uninstall Test

- 卸載 Utility Intelligence → 系統仍維持低 entropy → 仍是 Adiabatic ✓
- 卸載 Entropy Engineering → 系統不再越用越好 → 不是 Adiabatic ✗

### Utility Intelligence 為什麼是 App

1. **只讀不改結構** — 讀 organized data，產出 insight/view。不動 schema、permission、D0/D1/D2。
2. **不同用戶要不同 utility** — 健康分析 vs 財務分析。Opinionated，不該在 OS 層。
3. **可移除不影響 OS 身份**。
4. **分離讓兩者都更純** — Optimizer 是 content-agnostic entropy reducer。Utility app 是 domain-specific insight generator。

### 系統演化 Loop

```
用戶使用系統 → 資料累積（D 增長）
                ↓
Optimizer → 維持低 entropy（reorganize, promote, merge）
                ↓
Utility Intelligence (App) → 從 organized data 找 insight
                ↓
發現 gap → 建議新 app / connector
                ↓
用戶決定是否採納 → 系統演化
```

Optimizer 管秩序。Utility app 管價值。用戶管決策。三者分離。

---

## 20260304 修正：合併 Entropy Engineering 與 Utility Intelligence

上面把 Optimizer 定義為 content-agnostic、Utility Intelligence 歸為 app 層。這個分離不成立，原因：

1. **Content-agnostic 不成立** — entropy 的三個 proxy（semantic / structural / interaction）全都需要理解 content。你無法判斷「命名是否清楚」而不理解它在講什麼。entropy 的定義本身就包含 content。
2. **改善 app 就是降 interaction entropy** — 建 shortcut、調 flow、加新 app 都是 minimize E 的 action。拆到另一個 scope 反而製造 interaction entropy。
3. **Human as core** — 用戶不在乎手段是 merge schema 還是建新 app，在乎的是系統整體越來越好用。分離 objective function 才是核心問題，不是 content agnostic。

合併後：

```
一個 Optimizer，一個 objective（minimize E），三種 action space：
  1. 結構操作 — merge / promote / de-promote schema
  2. 功能操作 — 建 app / 改 app / 加 shortcut
  3. 介面操作 — 調 context default / 改 page layout / 改 flow
```

App 是 Optimizer 的 output artifact，不是平行的 scope。Optimizer 管秩序和價值。用戶管決策。

### 再修正：minimize E 和 maximize U 是兩個 objective

上面的合併過度了。Minimize E 和 maximize U 不是同一件事：

- **Minimize E** — 讓 data substrate 維持低 entropy。結構清楚、找得到、用起來不煩。
- **Maximize U** — 在 organized data 上做 domain-specific reasoning，產生對人有價值的 insight 和 action。

很多高價值的操作不是在降 entropy，而是在產生新的 judgment：
- 根據基因 × 健檢 × 日常記錄調整 schedule
- 觀察飲食 / 睡眠 / 能量 pattern 做出 prescriptive recommendation
- 根據 info flow 對情緒和 attention 的影響，反過來管理 info flow
- 主動發現 unknown unknowns：「你可以通過搜集 A, B, C 實現 X」——用戶自己不知道要問的問題

這類操作需要 domain knowledge + causal model + prescriptive reasoning，不是 entropy reduction 能覆蓋的。

所以正確的結構是兩層 objective：

```
Layer 1: minimize E — 管 data substrate 的秩序
Layer 2: maximize U — 在 organized data 上做 domain reasoning，產生 insight / action / 發現盲區

Layer 1 是 Layer 2 的 prerequisite（data 不乾淨什麼都做不了）
Layer 2 的 feedback 校準 Layer 1（什麼該 promote 取決於什麼對人有用）
Layer 2 的關鍵能力：主動發現 unknown unknowns，而非被動回應已知需求
```

這跟最初分離 Entropy Engineering / Utility Intelligence 的結構相同，但理由不同——不是 content-agnostic vs content-aware，而是 objective function 本質上就是兩個。原本的 uninstall test 仍成立，但邊界重新定義為 minimize E vs maximize U。
