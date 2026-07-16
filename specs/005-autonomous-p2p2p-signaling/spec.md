# Spec 005：自主連線 — bootstrap-only 的 p2p2p signaling

- 軌別：feature（含 protocol 成分：peer 中繼 signaling 與發現的線上格式，最終進 protocol 軌）
- 狀態：planned
- 建立：2026-07-16／最後更新：2026-07-16（clarify Q1-Q7 全拍板，plan 填入）
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

## 3. 待釐清（clarify）——2026-07-16 拍板

- [x] Q1 冷啟動會合點：**邀請連結內嵌會合資訊（最自主）**。見下方「物理限制」與 Q7。
- [x] Q2 隱私強度：**介紹人也不該看到（SDP 對介紹人加密，只轉密文）**。
- [x] Q3 發現：預設 **兩者**——邀請連結指名 + 房間目錄 gossip（ADR-0027）。
- [x] Q4 介紹人信任：由 Q2 導出——SDP 以**發起方身分金鑰簽章**（ECDSA，收端驗來源）＋**對收端 ECDH 加密**（介紹人只能轉、不能讀也不能竄改，竄改則簽章/解密失敗）。介紹人淪為不可信管道，安全不依賴其善意。
- [x] Q5 fallback：Firestore 作為**韌性底線**保留，僅當無任何 peer 路徑可用時才退回（Strangler；warm 路徑優先）。
- [x] Q6 範圍：**完整版**（warm peer-relay 主路徑 + 發現 + Firestore 底線）。

### 物理限制（實作期發現，2026-07-16）—— 衍生 Q7

**warm 路徑（已連上任一 peer → 由它介紹新對象）本質上零伺服器、可完全實現**，這就是「自主」的核心，加密介紹（Q2/Q4）在此成立。

但**冷啟動（兩個從未通訊過的瀏覽器要交換第一個 SDP）在物理上需要一個會合點**：瀏覽器無法被直接撥號（無公開 IP/port），第一包 offer 必須經某個雙方都能到的地方。邀請連結能把「房金鑰＋邀請者身分＋邀請者預先產生的 offer」塞進去，但**被邀請者的 answer 要送回邀請者，仍需一條回程管道**。這條回程不可能只靠一條連結消除。因此「完全不碰任何伺服器」對「素未謀面的第一次」不成立——這是 WebRTC 的固有限制，不是設計缺陷。

- [ ] Q7 **冷啟動的會合管道（回程）選哪個**（warm 路徑不受此影響）：
  - (a) 用我方 Firestore，但**只用於第一跳**（最小依賴；連上後全轉 warm）
  - (b) 第三方公共會合點（如 Nostr relay／公共 WebSocket）——「不是我的服務」但仍是伺服器
  - (c) 手動 copy-paste signaling（真正零伺服器：貼 offer、貼回 answer；最自主但最不順手，可當進階選項）

## 4. 技術計畫（plan）

### 4.1 連線模型（三態）

```
新對象 T 要連：
  有 warm 介紹人 X（已連、且 X 通得到 T）？ ──是──▶ PeerRelaySignalingTransport（經 X 中繼加密 SDP，零伺服器）
                                        └─否──▶ RoomSignalingTransport（Firestore 第一跳，冷啟動）
  warm 中繼中途失敗 ──▶ 退回 Firestore（韌性底線，Q5）
連上任一 peer 後，後續新對象一律優先走 warm。
```

### 4.2 加密 signaling 信封（protocol，Q2/Q4）

介紹人不可信，安全不靠它：

```
SignalEnvelope = {
  from: nodeId, to: nodeId, room: roomId, kind: 'offer'|'answer'|'ice',
  epoch, ts, nonce,
  ct:  ECDH-AES-GCM( SDP/ICE, 對 to 的 ECDH 公鑰 ),   // 介紹人解不開
  sig: ECDSA( canonical(前述欄位 + ct), from 的身分私鑰 )  // 介紹人改了就失效
}
```
收端 T：驗 `sig`（來源真實、未竄改）→ ECDH 解 `ct` → 得 SDP。介紹人 X 只依 `to` 轉發密文。
複用既有：`IdentityManager`（ECDSA/ECDH 金鑰）、`RecordCrypto`（AES-GCM 封套模式）。

### 4.3 承載與發現

- 承載：mesh bus 新 namespace `ns='sigrelay'`（lossy 可靠皆可，握手量小）；X 收到 `to≠自己` 的信封就往 T 的 mesh 路徑轉。
- 發現（Q3）：邀請連結內嵌 `{roomId, 房金鑰, 邀請者 nodeId+pubKey}` → 被邀請者指名邀請者為首個 warm 目標；連上後 `RoomDirectoryGossip`（ADR-0027）供後續 warm 發現。
- 冷啟動第一跳（Q7）：沿用 `RoomSignalingTransport`（Firestore `p2pRooms/{roomId}/signals`），僅在無 warm 介紹人時。

### 4.4 落地切面（複用為主，不重造）

- 新 `PeerRelaySignalingTransport implements SignalingTransport`（承載換成 mesh bus）；`P2PConnectionManager` 已可注入，不動連線本體。
- 新純模組 `SignalEnvelope`（sign/encrypt/verify/decrypt），零 I/O、可 property 測。
- 傳輸選擇器：連線流依「有無 warm 介紹人」選 transport，warm 失敗退 Firestore。
- 邀請連結產生/解析擴充（帶會合資訊）。

### 4.5 取捨（完成後回填 ADR）

- 冷啟動仍用 Firestore：WebRTC 物理限制（見 §3），選最小依賴而非硬去中心（Q7-a）。
- 介紹人加密而非明信：多一次 ECDH，但換得「介紹人不可信」的強保證，對齊隱私定位（Q2）。
- 不做純 DHT 冷啟動：維持 ADR-0011 判準。

## 5. 任務分解（tasks）

- [ ] T1：`SignalEnvelope` 純模組（sign+ECDH 加密 / verify+解密）＋單元＋property（任意 SDP 往返一致、異金鑰解不開、竄改必被抓）。
- [ ] T2 ⚠：`PeerRelaySignalingTransport`（承載 mesh bus ns=sigrelay，介紹人只轉 `to` 密文）＋記憶體多節點：A↔B 連上，C 經 B 中繼連到 A，斷言 B 讀不到 SDP。
- [ ] T3 ⚠：傳輸選擇器接進連線流（warm 優先、無介紹人走 Firestore、warm 失敗退回）；受影響連線 e2e 迴歸。
- [ ] T4：邀請連結帶會合資訊（roomId+金鑰+邀請者身分）＋解析；被邀請者指名邀請者為首個目標。
- [ ] T5：接 `RoomDirectoryGossip` 供 warm 發現。
- [ ] T6 ⚠：Vue e2e 三瀏覽器——兩人 Firestore bootstrap 連上，第三人由其一介紹加入且**第三人零 Firestore signaling 寫入**（網路請求可證）＋介紹人讀不到 SDP。
- [ ] T7：Protocol Spec 007（加密 peer-relay signaling 信封格式＋conformance）＋回填 ADR。

## 6. 驗收（黃金判準）

〈初步候選〉
- [ ] V1：兩 peer 經 Firestore bootstrap 連上後，第三 peer 由其中一人介紹加入，全程第三人不寫任何 Firestore signaling（網路請求可證）。
- [ ] V2：我方 Firestore signaling 停用（模擬服務掛掉）後，已有一個連線的網路仍能讓新 peer 經介紹加入。
- [ ] V3：惡意介紹人竄改 SDP → 被介紹方驗證失敗、不建立錯誤連線。
- [ ] V4（迴歸）：現有 2 人／mesh 連線、rejoin、golden-path 全綠不變。

## 7. 一致性自查（analyze，implement 前跑）

- [x] 方案覆蓋需求、無多做
- [x] 任務完整實現方案
- [x] 驗收能證明需求
- [x] 未違反憲法任何一條
