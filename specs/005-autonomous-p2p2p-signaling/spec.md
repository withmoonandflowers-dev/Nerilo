# Spec 005：自主連線 — bootstrap-only 的 p2p2p signaling

- 軌別：feature（含 protocol 成分：peer 中繼 signaling 與發現的線上格式，最終進 protocol 軌）
- 狀態：clarifying
- 建立：2026-07-16／最後更新：2026-07-16
- 關聯：ADR-0002（Firebase signaling）、ADR-0027（房間目錄 gossip）、既有 `RelaySignalingChannel`(P4-B)、`SignalingTransport` 可注入 port

## 1. 要做什麼、為什麼（specify）

目前所有連線的 signaling（SDP offer/answer、ICE candidate）都經過使用者的 Firestore（`p2pRooms/{roomId}/signals`）。這讓「找對象」與「交換連線資訊」都依賴中央服務。使用者要的是**自主**：只有在冷啟動、手上完全沒有任何 peer 可問時，才連到我方服務找第一個對象；一旦連上任一 peer，之後的連線改由既有 peer 互相介紹（peer 中繼 signaling），新成員可以完全不經過我方服務就加入。目標是把「對我方服務的依賴」壓縮到只剩 bootstrap，讓網路能自主延續，甚至在我方服務不可用時仍能靠既有 peer 擴散。

**憲法檢核**（constitution.md）：
- 目標函數加分項：隱私韌性（signaling 去中央化＝斷網/服務掛掉仍能連）；補助競爭力（自主 P2P 是「層而非 App」敘事的技術核心）；定位（強化「中央掛了也能通」）。
- 四條不變量影響：恰好一次〈無〉；E2EE〈可能有：peer 中繼 SDP 時，介紹人能否看到被介紹雙方的連線資訊，需設計〉；帳本正當性〈無〉；身分授權〈有：peer 中繼 signaling 的來源需可驗，防止惡意介紹人偽造/竄改 SDP〉。

## 2. 邊界（初步，clarify 後定案）

- 不重寫 WebRTC 連線核心（P2PConnectionManager 已可注入 SignalingTransport，本 spec 是換/加 transport，不動連線本體）。
- 不做完全無 bootstrap 的純 DHT 發現（維持 ADR-0011 觸發判準；冷啟動仍需一個已知會合點）。
- 不移除 Firestore signaling（作為韌性底線與 bootstrap 之一保留；本 spec 是加 peer-relay 主路徑，Strangler 式漸進）。

## 3. 待釐清（clarify）——等你拍板，全清才進 plan

- [ ] Q1 **冷啟動會合點**：第一次、手上沒有任何 peer 時，用什麼找到第一個對象？
  - (a) 維持 Firestore 房間 signaling（現況；最省事）
  - (b) 邀請連結內嵌「會合資訊」（某個常在線 peer 的位址 + 房金鑰），點連結就直接找那個 peer，完全不碰 Firestore
  - (c) 兩者都留：有邀請連結走 (b)，沒有走 (a)
- [ ] Q2 **「不把連線資訊傳給我」的目標強度**：
  - (a) 只要求「不經過我方 Firestore」即可，經過**其他 peer**（介紹人）中繼 SDP 可接受（介紹人看得到被介紹雙方的 SDP/IP）
  - (b) 更嚴：介紹人也不該看到內容，SDP 要對介紹人加密（介紹人只轉密文），只有被介紹的兩方解得開
- [ ] Q3 **發現（怎麼知道有誰可連）**：連上 mesh 後，新對象從哪來？
  - (a) 既有的房間目錄 gossip（ADR-0027，peer 間廣播房間廣告，已實作）
  - (b) 邀請連結直接指名對象
  - (c) 兩者
- [ ] Q4 **介紹人的信任**：peer 中繼 signaling 時，如何防止惡意介紹人竄改/偽造 SDP（把你導去攻擊者）？收端要驗什麼？（既有 `RelaySignalingChannel` 目前驗到什麼程度需查證後對齊）
- [ ] Q5 **fallback 政策**：peer-relay signaling 失敗（所有介紹人離線/不通）時，退回 Firestore 還是直接失敗？（Firestore 是韌性底線，但退回＝又碰我方服務）
- [ ] Q6 **範圍**：這次是「加一條 peer-relay 主路徑 + 保留 Firestore 底線」的完整版，還是先做「兩人已連線後，第三人可由其中一人介紹進來、不碰 Firestore」的最小可證版？

## 4. 技術計畫（plan）

〈clarify 清空後填。既有可複用：SignalingTransport 注入縫、RelaySignalingChannel、RoomDirectoryGossip、RelayConnector。〉

## 5. 任務分解（tasks）

〈plan 定案後填〉

## 6. 驗收（黃金判準）

〈初步候選〉
- [ ] V1：兩 peer 經 Firestore bootstrap 連上後，第三 peer 由其中一人介紹加入，全程第三人不寫任何 Firestore signaling（網路請求可證）。
- [ ] V2：我方 Firestore signaling 停用（模擬服務掛掉）後，已有一個連線的網路仍能讓新 peer 經介紹加入。
- [ ] V3：惡意介紹人竄改 SDP → 被介紹方驗證失敗、不建立錯誤連線。
- [ ] V4（迴歸）：現有 2 人／mesh 連線、rejoin、golden-path 全綠不變。

## 7. 一致性自查（analyze，implement 前跑）

- [ ] 方案覆蓋需求、無多做
- [ ] 任務完整實現方案
- [ ] 驗收能證明需求
- [ ] 未違反憲法任何一條
