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
