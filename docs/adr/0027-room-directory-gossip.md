# ADR-0027：房間目錄走 mesh gossip 廣播（去中心化大廳第一片）

狀態：Accepted
日期：2026-07-13
關聯：ADR-0023（P4 relay 基座）、ADR-0024（盲信使）、稽核 R6/R9、配額事件（2026-07-13）

## 背景

公開房發現原本完全仰賴 Firestore 大廳查詢：讀取成本（配額事件的元兇之一）、
可用性單點（稽核 R9）、與「韌性通訊」定位不符。P4 已建成陌生節點 relay 連線基座
（RelayConnector + P2PChannelBus namespace 分派），courier 騎 ns='courier'。

## 決策

公開房目錄以簽章廣告在 relay bus 上 gossip（ns='roomdir'，零新傳輸）：

- **廣告**：roomId/roomName/ownerUid/participantCount/issuedAt/nodeId/pubKey/sig；
  nodeId = hash(pubKey) 自我認證（同 gossip 訊息模式），簽章覆蓋固定欄位序。
- **驗證**：收端 fail-closed（pubKey↔nodeId 綁定 + ECDSA 驗簽）。
- **快取**：同房取 issuedAt 最新（冪等亂序收斂）、TTL 3 分鐘、per-node 防洪帽、
  總量帽（滿丟最舊）、未來時戳拒收。
- **交換協議**：attach 即 announce、首次聽到對方回播一次（消 attach 順序 race）、
  60s 週期重播。對稱協議，兩端同碼。
- **多跳**：announce 集合 = 自己的房（現簽）+ 快取轉發（原簽，下一跳仍可驗）。
  迴圈安全：轉發不改 issuedAt → upsert 冪等 + TTL 界壽命 + answer-once/週期界頻率。
- **連線來源（piggyback only）**：roomdir 只掛在「已存在的 relay 連線」上——信使角色
  的 listening 端、成員 courier backup 開的 outbound 端、以及顯式 connectToRelayNode。
  **不主動建新連線**。UI：dashboard「附近節點的公開房間」區塊（P2P 徽章），點擊即進房。

## 信任模型（誠實邊界）

- 簽章防「冒名替別人發廣告」；**不防「捏造自己名下的假房」**：join 仍由 Firestore
  rules 驗證，假房是死連結。防洪靠 per-node 帽 + 總量帽 + TTL。
- Firestore 大廳保留為 bootstrap/fallback（getPublicRooms 一次性 + limit 20）；
  本目錄是疊加的發現途徑，不是替代。首次相遇（signaling/名冊）仍需會合點。
- 已知未做：私人房不廣播（設計如此，走邀請連結）；「我的房間」列表仍以 Firestore
  為成員資格權威（去中心化成員資格是另一個量級的題目，不在本 ADR）。
- **piggyback-only 的代價**：兩個純 lurker（都沒 courier 活動、沒顯式連線）不會互相
  發現對方的房。曾試「主動對等（週期對線上節點建目錄連線）」補這個缺口，但雙向自動
  連線與 courier 的單向連線模型相撞（e2e relay 全套 deposit/sync timeout 回歸）。故
  revert，留待與 relay 連線模型相容的主動對等（如 lexicographic 單向發起）作後續。
  現況：有房或有 courier 備份活動的節點會連線 → 交換目錄，涵蓋主要場景。

## 驗證

單元 13（簽章/竄改/冒名/快取五邊界/attach 互通/detach/多跳三節點/merge）；
e2e room-directory（真 WebRTC 兩瀏覽器：bob 經 relay 看到 alice 的房並點進去）；
relay/courier P4 全套 + golden-path + rejoin 回歸全綠。

## 後果

- 公開房發現的讀取負載從 Firestore 移到 P2P（大廳查詢已降為一次性 fallback）。
- 韌性敘事成立：Firestore 讀掛掉時，已連線節點間仍能發現房間。
- 新攻擊面（廣告轟炸）以三重帽收斂；廣告內容為公開房 metadata，無機密性議題。
