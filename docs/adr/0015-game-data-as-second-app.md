# ADR-0015：遊戲資料流成為第二參考應用

- 狀態：Accepted（2026-07-03 產品負責人定調）
- 日期：2026-07-03

## Context

產品負責人定調：「不一定是聊天室，我想要可以變成是遊戲資訊的傳遞」。
這是 ADR-0009（Nerilo 是資料傳遞架構，聊天是參考應用）的字面實現——
遊戲成為平台的第二個消費者，正好對應 M4 的出口條件
「一個非聊天的新系統能只依賴傳輸層完成資料傳遞」。

資產盤點：ADR-0007 凍結的 game/ 模組（約 3.3K LOC）盤點結果遠比預期完整：
- 確定性 lockstep 原語齊全：InputBuffer（輸入同步）、GameStateValidator
  （state hash 抽驗防 desync）、DeterministicRNG（seed commit-reveal
  防作弊協商）、GameSession（成員與 host migration）、快照存取。
- GameTransportSDK 傳輸中立：吃注入的 IGameBroadcast 介面，
  廣播的 envelope 本來就是 ns:'game' 的 P2PEnvelope 相容格式。
- GameFeature 是完整 FeatureModule（handleEnvelope 入口、
  runtime payload 驗證防惡意 peer）。
當初凍結的理由是「定位相依，ADR-0009 拍板後決定」——現在拍板了。

## Decision

1. **game/ 模組解凍**：ADR-0007 分類從第 2 類（凍結）改第 1 類
   （待啟用戰略資產）。恢復其單元測試進 CI，移除 FROZEN.md。
2. **接線形狀**：GameTransportSDK 經薄 adapter 騎在 P2PChannelBus 上
   （broadcast → bus.send、bus.subscribe('game') → GameFeature.handleEnvelope）。
   先以整合測試證明（兩個 SDK 經連結 bus 完成輸入同步與 hash 驗證），
   UI demo（房間內小遊戲）排 M4。
3. **誠實的能力邊界**（寫進平台文件，呼應 GP2）：
   - 現行通道是 ordered + reliable + JSON——適合**回合制與 lockstep**
     （棋類、卡牌、策略）。SDK 的確定性 lockstep 設計正是此類。
   - **即時動作遊戲（60Hz 位置同步）不在現行能力內**：需要 unordered/
     unreliable 通道（maxRetransmits=0）+ 二進位編碼。這與 ADR-0010 的
     窄頻二進位需求合流：傳輸契約的「送達模式」維度增加 realtime-lossy
     等級，M4 契約設計一併涵蓋。
   - E2EE 對遊戲流量同樣適用（sender key 加密 payload），但 lockstep
     的 state hash 驗證天然提供完整性檢查，兩者互補不衝突。
4. **聊天與遊戲共存**：同一房間、同一 DataChannel，以 namespace 區分
   （'chat' 與 'game' 各自 subscribe）。房間是「資料流容器」不是「聊天室」，
   命名與 UI 逐步去聊天化（M4 的 SDK 化工作一部分）。

## Consequences

- 平台論點第一次有雙應用驗證：同一傳輸層同時服務聊天與遊戲，GP1
  解耦程度被真實檢驗。
- CI 測試數回升（game 模組測試恢復），維護面積增加約 3.3K LOC——
  這次是有買家的（方向已定），符合 ADR-0007 的解凍條件。
- 點數經濟（ADR-0011）自然延伸：遊戲流量走中繼同樣計費計點，
  遊戲場景（好友對戰、社群賽事）可能比聊天更快產生真實流量。
- community/ 模組（房間治理、信譽）與遊戲場景的相關性上升
  （賽事房、觀戰權限），維持凍結但解凍機率提高，逐案評估。
- 商業敘事更新：對外定位從「加密聊天」轉向「P2P 資料傳遞平台
  （聊天與遊戲是內建應用）」，投資者演示步驟文件需要在 M4 改版。
