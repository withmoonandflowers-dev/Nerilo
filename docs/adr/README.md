# Architecture Decision Records

決策記錄索引。編號不重用；被取代的 ADR 標記 Superseded 並保留。
背景推導見 [../GOAL-ANALYSIS.md](../GOAL-ANALYSIS.md)。

| 編號 | 標題 | 狀態 |
|---|---|---|
| [0001](0001-adopt-adr.md) | 以 ADR 記錄架構決策 | Accepted |
| [0002](0002-firebase-signaling-fallback.md) | Firebase 作為信令與 fallback 後端（補記） | Accepted |
| [0003](0003-tiered-p2p-topology.md) | 依人數分層的 P2P 拓撲（補記） | Accepted |
| [0004](0004-wire-e2ee-into-live-path.md) | 將 E2EE 接入即時訊息路徑 | Accepted |
| [0005](0005-server-side-quotas.md) | 伺服器端配額與速率限制 | Proposed |
| [0006](0006-blaze-plan-and-functions-deploy.md) | 升級 Blaze、部署清理 Functions、設預算斷路器 | Proposed |
| [0007](0007-dormant-module-quarantine.md) | 休眠模組隔離 | Proposed |
| [0008](0008-billing-and-entitlements.md) | 計費與授權架構 | Proposed |
| [0009](0009-target-market.md) | 目標市場與產品形態：資料傳遞架構、內部平台優先 | Accepted |
| [0010](0010-heterogeneous-transport.md) | 異質傳輸擴展原則（衛星、LoRa、業餘無線電） | Proposed |
| [0011](0011-relay-credit-economy.md) | 中繼點數經濟（過路有對價） | Proposed |
| [0012](0012-community-relay-infrastructure.md) | 社群自營中繼基礎設施（三層備援階梯） | Proposed |
| [0013](0013-cloud-platform-choice.md) | 雲平台選擇（Firebase vs AWS）：不遷移 | Accepted |
| [0014](0014-multi-device-identity.md) | 多裝置身分與同步（缺口，方向已定） | Proposed |
| [0015](0015-game-data-as-second-app.md) | 遊戲資料流成為第二參考應用（game/ 解凍） | Accepted |
| [0016](0016-ui-theming-not-framework-swap.md) | 視覺升級用多主題設計系統，不換前端框架 | Accepted |
| [0029](0029-courier-iou-claims.md) | 信使經濟採有對象、可同意交換的欠條 | Accepted |
| [0030](0030-courier-iou-durability.md) | 信使欠條簿採本機耐久快照與重載重驗 | Accepted |
| [0033](0033-migration-window-disposition.md) | React 遷移窗掉信不修，靠 Vue 切換退役星型棧收斂 | Accepted |
