# 202602140800 OS Infra — What to Design

OS infra 的 one-way door。需要設計對的東西，就這些。

用這個標準過濾一遍：                                                            
                                                                                      
  直接服務「越用越有序」：                                                            
  - D0/D1/D2 分層 — 就是 entropy 梯度本身。promote or demote = 降 overall entropy。
  - System API auto D0 log — 給 Optimizer 原料。沒有 D0 記錄，Optimizer 瞎的。        
  - Chunks/embeddings — 給 Optimizer 語意分析能力。
                                                                                      
  間接保護（防止 entropy 上升）/ decoupling：
  - Write permission check — 防 app 寫錯表
  - Sandbox — 防壞 code 搞亂資料

  跟「越用越有序」無關：
  - 5-layer model、5-scope model — 設計時用的 mental model，不是 runtime
  - Row namespace — 已移除
  - entities table — 已移除

  所以 OS infra 真正的核心就是：D0/D1/D2 + auto D0 logging。System API
  存在的最大理由是 auto D0 logging — 它讓 Optimizer 有東西可以分析。 還有 data layer & app layer 的 decouple

  如果某個抽象不能回答「這怎麼幫 Optimizer 做得更好」，大概率不需要。
---

## 要設計的

1. **D0 schema** — events table。append-only。系統的記憶。
2. **D1 schema** — docs table。MDX content + CRDT state。用戶思考的地方。
3. **System API** — app 跟 OS 互動的唯一介面。

  API 的細節（writeDoc 要不要獨立、promote 的 config 長什麼樣）不是 one-way
  door。真正的 one-way door 是 D0 和 D1 的 table schema — 欄位定了，資料進去了，改就要
   migrate。

---

## System API（目前版本）

```ts
// App 用的（日常）// Connector 用的 // OS 內部 / Optimizer 用的
system.query(sql, params)    // read（D0, D1, D2 全部）
system.write(sql, params)    // D2 write（auto D0 log）
system.writeEvent(source, kind, payload)  // D0 顯式寫入
system.writeDoc(id, content)   // D1 write（CRDT 語意）
system.deleteDoc(id)           // D1 soft delete
system.promote(config)         // DDL: 建 D2 table
system.demote(table)           // DDL: 歸檔 D2 table
```
每個 write method 內部自動：permission check → 執行 → D0 auto-log

---

## 不需要設計的（two-way door）

- D2 schema — 動態建的，沒有固定 schema
- entities table — 不需要，SQLite introspection + manifest + D0 夠用
- Sync 機制 — implementation detail
- Sandbox 策略 — implementation detail
- Chunks / embeddings table — sqlite-vec
- Reactive / subscribe — 未來加，不影響 schema
