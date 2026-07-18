# ADR-0033：退役 TreeKEM 與 GroupKeyManager（ADR-0031 續篇）

- 狀態：Accepted（2026-07-18，Spec 012 Q5 拍板）
- 日期：2026-07-18

## Context

ADR-0031 對 `core/crypto` 的 TreeKEM＋GroupKeyManager（約 1,100 行、46 個單元測試）
判「不動（待專門分析）」：當時擔心它們與活的 mesh crypto 糾纏，不敢草率處置。
Spec 012 的逐檔核對完成了那個專門分析，事實面：

- 兩者零 app 引用；`RoomKeyDistribution` 檔頭明言刻意不用其重機，實際引用只有註解。
- live 的 mesh 群組金鑰方案（ADR-0023 P2：keyx 紀錄分發＋RecordCrypto 單一密文信封）
  已在 production 驗證，與「金鑰即日誌紀錄、經 anti-entropy 補齊」的世界觀一體成形。
- TreeKEMManager 自述「assumes ordered delivery（no out-of-order handling）」，
  與 gossip 最終一致、亂序到達、補送常態的環境根本相悖；要採用必須大改，等於重寫。
- 規模論證失效：TreeKEM 的 O(log N) 優勢在 50+ 人才有感；本專案拓撲上限 20 人
  （partial mesh），keyx 的 O(N) ECDH 封裝在名冊變動時做一次，20 人＝20 次 ECDH，
  瀏覽器毫秒級。

## Decision

刪除 `src/core/crypto/TreeKEMManager.ts`、`src/core/crypto/GroupKeyManager.ts` 與其
測試（−46 tests）。復活路徑＝git 歷史（本 commit 之前任一版本）。

不移入 attic／不加圍籬：這兩個模組在 PARK 圍籬（ADR-0031）之外的 `core/crypto`，
留著就是「架構圖上有兩套群組金鑰機制」的敘事混亂與最高風險層的維護面積。

## Consequences

- 群組金鑰機制單一化：keyx-as-record 是唯一路線，文件與架構圖不再有分歧敘事。
- 單元基線 −46 tests（CURRENT-STATUS 同步更新）。
- 若未來需求走向 50+ 人大群組，屆時的正確起點是針對亂序日誌設計的方案
  （或改造 MLS），而不是復活這份有序送達假設的實作；git 歷史仍可考古。
- CLAUDE.md、RecordCrypto／RoomKeyDistribution 檔頭註解同步去除指涉。
