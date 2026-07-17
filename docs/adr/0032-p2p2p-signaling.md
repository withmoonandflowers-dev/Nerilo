# ADR-0032：p2p2p 自主 signaling——加密 peer 中繼為主、Firestore 縮為 bootstrap

- 狀態：accepted（2026-07-16）
- 關聯：Spec 005（feature）、Protocol Spec 007（nsig1 線上格式）、ADR-0002（Firebase
  signaling，本 ADR 將其角色降級）、ADR-0027（房間目錄 gossip）、ADR-0031（收斂裁決）

## 背景

所有 WebRTC signaling 原本都經使用者的 Firestore（`p2pRooms/{roomId}/signals`），
「找對象」與「交換連線資訊」皆依賴中央服務。產品定位（隱私韌性、中央掛了也能通）
要求把這個依賴壓到最小：只有冷啟動（手上零 peer）才碰我方服務，之後由既有 peer
互相介紹，新成員可完全不經我方服務加入。

## 決策

1. **三態連線模型**（Spec 005 §4.1）：新 pair 的 signaling 優先走**加密 peer 中繼**
   （warm；nsig1 信封，Protocol Spec 007）；無暖路徑或中繼失敗退回 Firestore（cold，
   韌性底線）。Strangler：不移除 Firestore 路徑，逐步縮小其使用面。
2. **介紹人是不可信管道**：SDP 對收端 ECDH 加密（介紹人讀不到，含 ICE 內 IP）、
   發起方 ECDSA 簽整個信封（介紹人改任一位元組即被拒）。HKDF 域分離
   （`nerilo-signal-relay-v1`），與 sender-key 分發不共用金鑰。
3. **冷啟動走 Firestore 第一跳（Q7-a）**：兩個素未謀面的瀏覽器交換第一個 SDP
   物理上需要會合點（瀏覽器不可被直接撥號）。選最小依賴（僅第一跳）而非硬去中心
   （公共 relay＝別人的伺服器；copy-paste＝可用性懸崖，留作未來進階選項）。
4. **邀請連結內嵌會合資訊（nrz1）**：邀請者 uid＋公鑰放 URL fragment（不上送
   伺服器）。公鑰構成頻外信任根——名冊供應者換鑰 MITM 可被比對抓到。
   **房金鑰不放連結**：E2EE 金鑰仍由 keyx 成對封裝分發，連結外洩≠金鑰外洩。
5. **介紹加入的有界耐心**：對被介紹的 pair，warm 無路先等（20s、每秒重試）再退
   cold——介紹人可能還在接他。有界，不犧牲 liveness；介紹人自己對被介紹者不等
   （他就是會合點）。
6. **hop 上限 1、hop-by-hop ACK/NACK**：介紹人只轉直連鄰居，不洪泛（signaling
   無放大係數）；NACK 毫秒級讓退守快。回放緩衝鏡像 Firestore lookback 語義。

## 取捨

- **加密介紹 vs 明信介紹**：多一次 ECDH＋簽驗，換得「介紹人不可信」的強保證。
  對齊隱私定位；成本在握手路徑（低頻）可忽略。
- **Firestore 第一跳 vs 純 DHT/公共會合**：維持 ADR-0011 觸發判準；「零伺服器的
  第一次接觸」違反 WebRTC 物理，誠實承認而非偽裝。
- **選擇器包 factory vs 改 P2PConnectionManager**：選前者——連線本體（perfect
  negotiation、mutex、去重、ICE restart）一行不動，全部複用；傳輸位置是
  `SignalingTransport` 縫的本職。
- **耐心窗 vs 立即退守**：立即退守讓被介紹者白寫 signaling（違背自主目標）；
  無界等待犧牲 liveness。取有界耐心，參數見 Spec 005 實測註記。
- **中繼資料**：介紹人知道「誰想連誰、在哪房」。隱藏社交圖譜非本階段目標，
  格式預留疊加洋蔥路由（信封可作 Sphinx 內層 payload）。

## 後果

- 對我方服務的依賴縮為：冷啟動第一跳＋名冊（發現）。V2（服務掛掉、既有網路
  自行擴散）由 warm 路徑承載；名冊的去中心化替代由房間目錄 gossip（ADR-0027，
  已騎上暖 mesh）漸進接手。
- `SignalingFactory` 增可選 `remoteUid` 參數（向後相容）；名冊身分增可選
  `introducedBy` 欄位（rules 已驗）。
- 新公開概念：nsig1（協議）、nrz1（邀請會合）。SDK 表面未動（接線在內部）。
