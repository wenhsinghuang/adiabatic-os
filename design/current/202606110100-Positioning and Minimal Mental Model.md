# 202606110100 Positioning and Minimal Mental Model

Status: canon — product-facing language.

---

## 定位

> Adiabatic is the memory layer for your work and life.

中文：

> Adiabatic 是你的個人記憶層：把你每天實際做過、看過、想過的東西，變成可搜尋、可追溯、可重組的長期 context。

攻擊角度：

> Your AI should not have amnesia. Your memory should not belong to one AI company.

現在每個 AI 都想建立自己的 memory，但 memory 應該屬於使用者。Adiabatic 的位置是人和 AI 之間的 **durable context layer**。

長期 claim：

> Adiabatic makes your personal context compound.

---

## 最小 mental model

1. **Events**
   發生過的事。append-only history。
   對應 D0。

2. **Data**
   系統目前整理出的可用狀態。
   包含 pages/docs、tables、objects、summaries、project state。
   對應 D1 + D2。

3. **Connectors**
   把外部世界帶進來。
   Calendar/GitHub/browser/terminal/health/email 都是 connector。

4. **Apps + Sandbox**
   被限制住的能力單元。
   App 可以提供 UI、job、automation、analysis，但不擁有 data。

5. **Guard**
   所有持久改動的邊界。
   AI、app、connector 要寫 events 或 data，都要過 Guard。

**Events = history of what happened.**
**Data = current useful shape of what we know.**

`Page` 只是 Data 的一種形狀。
`Task table` 也是 Data。
`Project dashboard state` 也是 Data。
`Weekly review doc` 也是 Data。

產品核心句：

**Connectors bring in context. Events preserve history. Data holds the current shape. Apps act in sandboxes. Guard controls every lasting change.**

中文：

**Connector 接入脈絡；Event 保存歷史；Data 承載目前整理出的形狀；App 在 sandbox 裡行動；Guard 控制所有持久改動。**

這剛好 cover D2，不需要再額外教 projection/schema/table。
使用者只要懂：AI 可以把 Events 整理成 Data，也可以做 Apps 來操作 Data，但所有持久改動都會經過 Guard。
