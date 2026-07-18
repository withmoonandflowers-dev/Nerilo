# ADR-0007：休眠模組隔離

- 狀態：Proposed
- 日期：2026-07-03

## Context

src/core 共 22.1K LOC，實際被 app 使用的只有約 4K（p2p、mesh、clock、metrics
與部分 crypto）。其餘約 18K LOC 休眠：game（3.3K）、relay 大部分（3.6K）、
community（2.3K）、transport（2.0K）、chain（0.9K）、ledger、adapters、
incentive、protocol。這些程式碼有測試、進 CI、跟著依賴升級，
但沒有服務任何使用者。

單人團隊的維護預算是最稀缺資源。72% 的核心程式碼面積在消耗
type-check、測試時間、升級成本與認知負擔，卻不產生營收。
其中部分模組（incentive、crypto）在商業化路線圖上有明確用途，
部分（game、community、chain）取決於尚未拍板的市場定位（ADR-0009）。

## Decision

把休眠模組分成三類處理（2026-07-03 依 ADR-0009 定調修訂：
Nerilo 定位為資料傳遞架構，transport 與 ordering 因此升格為戰略資產）：

1. **待啟用戰略資產**：crypto 的 SenderKeyManager（ADR-0004）、
   transport 的 StoreAndForward 與多通道 bus、ordering 的
   CausalOrderingBuffer 發送端接線、relay 的 MessageAssembler（去重上移）。
   這些是正確性支柱（GOAL-ANALYSIS GC）的實作載體，於 M4 平台抽取時接線。
   incentive 維持休眠介面（ADR-0008 明確不作為計費依據）。
2. **凍結**（與資料傳遞定位無關但移除成本或翻案成本高）：~~game~~、community、
   超過 5 人的拓撲（partial mesh、super-node）、relay 的 Sphinx/DHT 深層、
   chain、ledger。CI 維持編譯但停跑其單元測試，檔案頂部標註凍結狀態與
   本 ADR 編號。有真實需求再逐案解凍。
3. **移除**：adapters（Browser/Node 抽象，型別層從未實例化，平台化時
   若需要會以新形態重寫）、transport 內的 DHT 儲存。移出主幹到 archive/
   分支保存，git 歷史不會遺失任何東西。

執行順序放在 M1 之後（先修真實性，再瘦身），避免與 E2EE 接線互相干擾。

2026-07-03 修訂二：game/ 依 ADR-0015（遊戲資料流成為第二參考應用）解凍，
自第 2 類移至第 1 類，測試恢復進 CI。這是本 ADR 預設的解凍路徑第一次生效。

2026-07-18 修訂三：「超過 5 人的拓撲」部分解凍——partial mesh（7-20 人檔）依
Spec 011／ADR-0035 接線至產品流（房間上限 10）；super-node（>20 人）維持凍結。
解凍路徑第二次生效。

## Consequences

- 主幹 LOC 約減 40%，CI 變快，升級面積縮小，新協作者（或另一台機器的 Claude）理解成本大幅下降。
- 「完整平台願景」的展示效果變弱。對投資人敘事有影響，但 demo 可以指向 archive 分支。
- 若 ADR-0009 選了需要 game 或 community 的方向，從凍結狀態解凍的成本低；從 archive 分支撈回的成本中等（需 rebase 適配）。
- 風險：休眠模組間有隱性依賴（例如 mesh 引用 relay 的型別），移除前需要一次依賴掃描，凍結類別先行、移除類別後行。
