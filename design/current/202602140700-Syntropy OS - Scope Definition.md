# 202602140700 Syntropy OS — Scope Definition

系統的五個 scope，各自職責與邊界。

---

## 核心目的

**在持續增長的資料量下維持低 entropy。**

OS = Infra + Entropy Engineering。兩者合起來 = self-maintainable low-entropy system。

---

## 五個 Scope

### 1. OS（Infra）

D0/D1/D2 schema + Guard。系統的骨架。

- **D0: events** — append-only raw signal。最硬的 invariant。
- **D1: docs** — MDX content, CRDT sync。同時是 data 和 interface。
- **D2: tables** — schema-defined structured data。entropy 最低層。
- **Guard** — 唯一 enforcement point。permission check + schema validation + auto D0 logging。

One-way door。改 schema = migrate 所有資料。必須設計對。

### 2. Entropy Engineering

Optimizer。OS 的目的層。

- **Objective:** minimize E (structural + semantic + interaction entropy)
- **Constraint:** 不能刪資料，只能 reorganize / promote / merge / restructure
- **核心 trade-off:** 拿結構熵當貨幣，買語意清晰度和交互順暢度

Optimizer 的維度和權重是 two-way door（implementation detail，可進化）。但 Entropy Engineering 本身是 OS 不可移除的部分 — 卸載它 = 系統不再越用越好 = 不是 Syntropy。

### 3. Apps

Sandboxed 功能意圖。可拋的。

- 每個 app = manifest + code
- 三層隔離：data（Guard enforce）、build（獨立 compile）、network（TBD）
- System owns all tables，app 只被 grant write permission
- Universal read, scoped write

Utility Intelligence 是一種 app — 從 organized data 萃取 personal insight 的 app。只讀不改結構，domain-specific，可替換。

### 4. Pages

MDX composition layer。最可拋的。

- MDX + component registry + mdx-bundler + reactive SQL query
- 跨 app boundary 的唯一合法場所 — page 自由引用任何 app 的 component
- Sidebar = file tree
- App 之間零耦合，page 是黏合劑

### 5. Connectors

外部資料的入口。

- 拉外部資料進 D0（raw events）
- 用戶配置，可隨時增刪
- 例：Oura, GitHub, Calendar...
- 可能需要 network permission（app sandbox network isolation 的例外？TBD）

---

## Uninstall Test

| 卸載什麼 | 結果 | 結論 |
|----------|------|------|
| OS Infra | 沒有資料層 | 不可卸載 |
| Entropy Engineering | 系統不再越用越好 | 不可卸載 |
| 某個 App | 功能少了，系統仍健康 | 可卸載 |
| 某個 Page | 少一個 view，data 不受影響 | 可拋 |
| 某個 Connector | 少一個資料來源 | 可卸載 |

---

## One-way vs Two-way Doors

| Scope | Door | 理由 |
|-------|------|------|
| D0/D1/D2 schema | One-way | 改 schema = migrate 所有資料 |
| Guard API | One-way | 所有 app 依賴它 |
| Entropy 維度 / 權重 | Two-way | Optimizer implementation detail |
| App sandbox 策略 | Two-way | 不影響 data schema |
| Connector 設計 | Two-way | 可隨時增刪 |
| Pages 渲染方式 | Two-way | 不影響 data |
