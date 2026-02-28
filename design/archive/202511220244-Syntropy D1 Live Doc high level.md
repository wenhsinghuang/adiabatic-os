## Live Doc 的 edit events / versioning 要怎麼設計

這個真的不能混在「一般 D0 event」裡用同一邏輯處理，不然會：

- 要嘛記太細：每個 keystroke 一筆 D0 → 爆炸
    
- 要嘛只留最新內容：語意演化的軌跡全不見
    

### 2.0 先定目標

我們想要同時滿足：

1. **體驗層**：編輯要順滑（用 CRDT / local state 寫就好，不能因為要記 event 把編輯拖慢）
    
2. **語意層**：能回頭看到「重要版本」，LLM 可以分析「這篇 doc 隨時間的演化」
    
3. **行為層**：可以從「哪時候 edit 哪份 doc、花多久」推回 time tracking / flow state
    
4. **容量 & 熵**：不要把 keystroke 級別的垃圾變成永久資產
    

所以我會把 Live Doc 相關的東西拆成三層：

- **L0-op：細粒度操作流（可壓縮 / 可捨棄）**
    
- **D1-version：語意版本 snapshot（主要資產）**
    
- **D0-meta：編輯 session metadata（時間行為）**
    

---

### 2.1 L0-op：Doc 操作流水（可壓縮 / 不一定永存）

這一層是最底層：

- 來源：
    
    - CRDT update（Yjs update）、
        
    - patch-based diff、
        
    - 或者每 X 秒把 delta push 一次
        

**特點：**

- 粒度小、數量巨大
    
- 主要用途：
    
    - 衝突解決 / recovery
        
    - 「重建某一時間點內容」的技術保險
        
- 不一定要長期保存（可以壓縮成段落差異或刪掉舊的）
    

你可以選兩種做法之一：

1. 真正存完整 CRDT log（比較硬派，但同步體驗最佳）
    
2. 只存「粗略增量 + 定期 snapshot」，足夠用來 debug / 重建最近編輯
    

這一層本質上也屬於 **D0.events** 的一種：

`kind   = 'doc_edit_op' source = 'app:editor' payload = {   "doc_id": "doc_abc",   "op": "...",        -- yjs update 或 patch   "client_id": "...",   "seq": 123 }`

> 這些東西是「操作層熵」，我們只保留它到能確定 doc 已被穩定 snapshot，之後可以壓縮或丟掉。

---

### 2.2 D1-version：Live Doc 語意版本（高品質土壤）

這是重點。

我會讓 `docs` table 存 **「當前版本的 head」**，  
然後另外建一張 `doc_versions`：

`CREATE TABLE docs (   id           TEXT PRIMARY KEY,   title        TEXT,   doc_type     TEXT,   current_ver  INTEGER NOT NULL,   created_at   INTEGER NOT NULL,   updated_at   INTEGER NOT NULL );  CREATE TABLE doc_versions (   id           TEXT PRIMARY KEY,   doc_id       TEXT NOT NULL REFERENCES docs(id),   version      INTEGER NOT NULL,   created_at   INTEGER NOT NULL,   author       TEXT NOT NULL,                    -- 'user' | 'app:<id>' | 'agent:<id>'   content_mdx  TEXT NOT NULL,   summary      TEXT,                             -- optional, optimizer/LLM 產出的摘要   change_note  TEXT,                             -- optional, 用戶/LLM寫的changelog   UNIQUE (doc_id, version) );`

**什麼時候產生一個 version？**

不要每次 keydown 就 version++，而是：

- 使用者顯示動作：
    
    - 點「Save checkpoint」
        
    - 點「Done for now」
        
- 自動策略：
    
    - Doc 關閉且距前一版本已過 X 分鐘
        
    - 編輯 session 超過一定變更量（例如字數變化>5%）
        

**與 D0 的關係**

每產生一次 `doc_versions`，可以記一筆 D0 event：

`{   "kind": "doc_snapshot",   "source": "app:editor",   "actor": "user",   "payload": {     "doc_id": "doc_abc",     "version": 5,     "chars": 2381   } }`

LLM pipeline（例如「分析這篇 doc 過去一週的變化」）就可以：

- `SELECT * FROM doc_versions WHERE doc_id = ? ORDER BY version`
    

> 這層才是「D1 高品質語意土壤」——  
> 你真的寫完、覺得有意義的那個狀態，才被當作版本長久保存。

---

### 2.3 D0-meta：編輯 session metadata（行為視角）

除了內容版本，我們還關心：

- 你什麼時候開始打開這篇 doc
    
- 編輯了多久
    
- 這段時間注意力是否中斷
    

這些可以當作另一種 D0 events：

`{   "kind": "doc_edit_session",   "source": "app:editor",   "actor": "user",   "payload": {     "doc_id": "doc_abc",     "started_at": 1732310000000,     "ended_at": 1732313600000,     "keystrokes": 800,     "versions_created": [4, 5]   } }`

之後 Time Tracker / Focus App 就可以用這個：

- 連接 ActivityWatch 的 window events & iOS ScreenTime →  
    推出「真實專注於這篇 doc 的時間」
    

---

## 3. 這些怎麼串回你的 D0/D1/D2 架構

簡化 mapping：

- **D0**
    
    - `doc_edit_op`：細粒度編輯操作，可壓縮/淘汰
        
    - `doc_edit_session`：編輯 session metadata
        
    - `doc_snapshot`：每次版本產生的記錄（指向 D1 `doc_versions`）
        
- **D1**
    
    - `docs`：doc 的 identity + 當前版本
        
    - `doc_versions`：語意版本（LLM / 人類分析主要吃這裡）
        
- **D2**
    
    - 從 `doc_versions.content_mdx` 抽取出：
        
        - `tasks`, `projects`, `mood_logs`, `worklogs`, `insights`…
            
    - 透過你前面說的 D1→D2 LLM ETL pipeline
        

> 看成三句話：
> 
> - D0：**「我那時候在這篇 doc 上做了什麼」**
>     
> - D1：**「那段時間這篇 doc 的語意快照」**
>     
> - D2：**「從這篇 doc 抽出來的結構化自我模型」**
>     

---

## 4. 為什麼要「特別對待」 Live Doc edit / version

你直覺是對的，原因其實就是：

1. **它同時牽涉三種熵：**
    
    - 操作熵（keystrokes / CRDT ops）
        
    - 語意熵（內容怎麼演化）
        
    - 行為熵（你如何在這上面花時間）
        
2. 如果只當 D2 CRUD 來看，會把這三種東西混在一起，  
    最後變成「只有最新內容」+ 一堆難用的 raw log
    
3. 如果設計好三層：
    
    - 你可以為：
        
        - **系統**：保留足夠的技術 log 做同步 & debug
            
        - **AI**：提供乾淨的版本序列做語意分析
            
        - **自己**：清楚看到「這篇 doc 怎麼從 v1 → v7」這種人生故事