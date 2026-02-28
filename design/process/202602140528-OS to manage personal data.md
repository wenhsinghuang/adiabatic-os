
傳統 OS 管理的「資源」是硬體 — CPU, memory, disk, I/O。                             
                                                                                      
  Syntropy 管理的「資源」是 你的 data。                                               
                  
  把兩者對照：                                                                        
  ┌────────────────────────────────────────┬────────────────────────────────────────┐
  │                傳統 OS                 │              Syntropy OS               │ 
  ├────────────────────────────────────────┼────────────────────────────────────────┤
  │ Kernel 保護 hardware 不被 process 搞壞 │ Guard 保護 data 不被 app 搞亂          │
  ├────────────────────────────────────────┼────────────────────────────────────────┤
  │ Filesystem 是 persistence layer        │ LibSQL (D0/D1/D2) 是 persistence layer │
  ├────────────────────────────────────────┼────────────────────────────────────────┤
  │ Process 透過 virtual memory 隔離       │ App 透過 manifest + Guard 隔離         │
  ├────────────────────────────────────────┼────────────────────────────────────────┤
  │ Shell (bash) 是 user interface         │ MDX pages 是 user interface            │
  ├────────────────────────────────────────┼────────────────────────────────────────┤
  │ 沒有主動優化                           │ Optimizer 主動降 entropy               │
  └────────────────────────────────────────┴────────────────────────────────────────┘
  所以它是一個 data OS — 把你的 personal data 當作需要被管理、保護、優化的核心資源。

  傳統 OS 的假設是：compute 是稀缺資源，要有效分配。
  Syntropy 的假設是：attention 是稀缺資源，data 會無限增長，要有系統幫你管。

  最後一行是關鍵差異 — 傳統 OS 只防壞（isolation,
  permission），不會主動讓系統變好。Syntropy 有
  Optimizer，它不只防壞，它主動讓系統越來越乾淨。

  一句話：

  A data OS that manages your personal information the way Linux manages hardware —
  isolate, protect, and actively optimize.