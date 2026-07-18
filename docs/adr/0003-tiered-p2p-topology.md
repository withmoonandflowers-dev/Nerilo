# ADR-0003：依人數分層的 P2P 拓撲（補記）

- 狀態：Accepted（既有決策回填）
- 日期：2026-07-03（決策實際發生於專案初期）

## Context

WebRTC full mesh 的連線數是 O(n^2)，瀏覽器端超過 5 至 6 人即不可行。
不同房間規模需要不同拓撲。

## Decision

依參與人數自動選擇拓撲（ChatPage.tsx 的 decideArchitecture()）：
2 人走星型直連（P2PManager），3 人以上走 gossip mesh（MeshGossipManager），
規劃中的 6 至 20 人 partial mesh 與 20 人以上 super-node 已有程式碼但未接入。
任何拓撲失敗時退回 Firestore 中繼。

## Consequences

- 2 人情境（最常見）路徑最短、延遲最低，已被 @stable E2E 覆蓋。
- mesh 路徑（3 人以上）程式碼已上線但實測稀少，是品質風險集中區。商業化前需要真實多人煙霧測試。
- 分層策略讓後續「按方案限制房間人數」有自然的落點：免費層限 2 至 5 人（星型與小 mesh），付費層開放大房間（見 ADR-0008）。
- partial mesh 與 super-node 在市場定位（ADR-0009）拍板前維持休眠，不投入接線（見 ADR-0007）。

2026-07-18 修訂：partial mesh 已接線（Spec 011／ADR-0033）——第 7 人起切
partial-mesh（只升不降），房間上限 10、容量分層 Free 5／Pro 10 落地。
super-node（>20 人）維持凍結。「按方案限制房間人數」的預留落點自此兌現。
