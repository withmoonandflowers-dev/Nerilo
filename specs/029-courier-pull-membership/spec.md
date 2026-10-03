# Protocol Spec 029：信使 PULL 綁房籍 v0.1

- 軌別：protocol（跨實作互通層；變更視同公開 API 破壞性變更）
- 狀態：clarifying
- 建立：2026-09-05／最後更新：2026-09-05
- 關聯：ADR-0024、Spec 021、Spec 028 R8／R11、Protocol Spec 003、`P2PEnvelope` v1

> 本規格的目標讀者包含以其他語言實作相容信使的人。規範以 JSON 線上格式與語義為準；TypeScript 路徑只用來標示參考實作與已知偏離。

## 1. 目的與範圍

本協議收緊盲信使的房間讀取路徑。信使只有在確認目前通道的請求者身分、可驗證的房籍憑證與一次性請求證明後，才能回傳指定房間的密文紀錄。任何驗證失敗都須在呼叫 `serveRoom`、`roomStore` 或建立其他房間讀取結果前拒絕，不得洩漏該房是否有紀錄、紀錄量或 `senderId` 集合。

現行 `pull` 分支只取 `roomId`、呼叫 `store.serveRoom(roomId)` 並回覆 `records`，位置為 `src/core/relay/CourierService.ts:372-376`。`sync` 也會依 `roomId` 回傳紀錄，位置為同檔第 386 至 403 行，因此本規格把 PULL 定義為所有會讀出房間紀錄的操作，至少包含 `pull` 與 `sync`。只保護 `pull` 而放行 `sync` 不能修補 R8。

ADR-0024 記錄的是寄存配額與四層刪除機制，墓碑須有房籍簽章，但沒有記錄 PULL 授權的取捨。Spec 021 的「身分與授權：無影響」描述 `runCourierBackup` ingest 前的紀錄驗簽，不是誰能向信使取回。因此 R8 是未記錄的授權缺口，不是既有決策接受的風險。

本規格走 protocol 軌。房籍證明會改動信使與客戶端的線上訊息格式，舊版與新版實作必須共存並有明確退場方式。依憲法第 15 條，這類變更按公開 API 的破壞性變更管理，必須定義版本協商、拒絕語義與相容期間。

### 1.1 四條核心不變量

- **訊息恰好一次**：授權只控制密文紀錄能否離開信使，不改 `(senderId, sessionEpoch, seq)`、`messageId` 或收端去重規則。重試可能再次取得同一筆密文，收端仍須維持恰好一次呈現。未授權請求須在 `serveRoom`、`roomStore` 或其他房間資料讀取前拒絕，不得刷新房間 LRU。
- **E2EE 機密性**：信使仍是盲的，不取得房間內容金鑰，也不解密紀錄。房籍憑證與請求證明只能授權讀取密文，不能取代內容金鑰或證明請求者能解密。新增欄位會增加身分與房間關聯的中繼資料，列入第 8 節風險。
- **點數帳本正當性**：本規格不改寄存報價、欠條、共簽收據或計點。拒絕的讀取不得產生服務收據或點數；若 B1 需要改 `CongestionPricing.ts` 或收據格式，須另行回填 Protocol Spec 003 與 ADR。
- **身分與授權**：這是本規格的主要影響。授權邊界由「知道 `roomId` 即可讀」收緊為「目前通道已識別的節點，持有可驗房籍憑證，並對信使的一次性 challenge 完成簽章」。此授權只涵蓋指定房間的信使密文讀取，不授予加入房間、讀取 Firestore 文件、寫入房籍或取得房間金鑰的權利。

### 1.2 目標函數

- **補助競爭力**：加分。把已知的未授權讀取缺口變成可展示、可測量的協議邊界。
- **可維運**：加分。版本協商、拒絕原因與隔離退場條件都有明文規範，避免新舊節點以靜默降級掩蓋問題。
- **可嵌入**：加分。線上格式不依賴 React、Vue、Firebase 或 TypeScript，其他實作可依相同測試向量互通。
- **隱私韌性**：直接加分。未授權節點不能再用已知 `roomId` 查詢密文存量與寄件人集合，信使仍不取得房間金鑰。

## 2. 術語與邊界

### 2.1 術語

- **信使（courier）**：代管房間密文紀錄並處理 courier namespace 的節點。
- **請求者（requester）**：在一條信使通道上先完成 `identify`，再要求讀取某房紀錄的節點。
- **通道端點 id（channelPeerId）**：承載信封的 `from`。它是傳輸端點識別，不必等於由 ECDSA 公鑰導出的 `requesterNodeId`。
- **房籍憑證（membership credential）**：由受信任房籍權威簽發，聲明某個 `requesterNodeId` 在某房籍世代內可讀取信使密文的可驗資料。
- **一次性 challenge**：信使針對一條通道、一個已識別請求者、一個房間與一種操作建立的短效隨機值，只能成功使用一次。
- **受保護讀取**：`P2PEnvelope.v = 2` 的 `pull` 或 `sync`。兩者都必須通過本規格授權。
- **觀察模式**：相容過渡期間暫時記錄舊版未授權讀取，但仍沿用舊行為的模式。此模式仍有 R8 缺口，不得宣稱已修正。
- **強制模式**：不再向任何 v1 `pull`／`sync` 回傳紀錄，且 v2 讀取須通過全部授權檢查的模式。

### 2.2 明確不做

- 不解凍 super-node，也不改房間容量上限。
- 不解凍 ledger，不改欠條、收據、計價或點數帳本。
- 不解凍 `src/core/relay/onion/`。
- 不修改 `firestore.rules`。Spec 028 R11 屬 Firestore 規則層與 production 部署裁決，不在本規格內實作。
- 不修改提案原稿或 `送件檔/`。
- 不把瀏覽器節點描述為 TURN。這裡規範的是應用層信使密文取回。
- 本規格只定義協議與驗收。B1、B2 的程式實作、遷移開關與部署時程另行排程。

## 3. 待釐清

- [ ] **Q1 房籍權威與首次信任根**：現有信使沒有房間名冊或可信房主公鑰。B1 前須裁決由誰簽發第 4.2 節房籍憑證，以及信使如何首次固定該權威。候選包含房主身分金鑰、由現行 keyx 名冊導出的房籍權威，或另一個經 ADR 核准的房間專用權威。單靠「某個 `senderId` 曾出現在 courier store」不可採用，因為寄存紀錄不等同目前房籍，也不能建立可信的首次權威。
- [ ] **Q2 房籍世代與撤銷**：須決定 `membershipEpoch` 的權威來源、成員離開或遭移除時如何推進世代，以及信使如何取得最新世代。未解決前，舊成員可能持舊憑證繼續讀取新紀錄。本規格不以單純短效憑證掩蓋世代缺口。
- [ ] **Q3 challenge 與憑證期限**：須用量測決定 challenge 最長有效時間、房籍憑證有效時間與允許的時鐘偏差。期限須足以容忍正常瀏覽器排程，又不能讓擷取後的證明長時間可用。
- [ ] **Q4 觀察期退場門檻**：須由操作者裁決觀察模式的最長期限、舊版使用率門檻、遙測欄位與強制模式切換日期。觀察模式會延續已知資訊外洩，只能是有期限的遷移措施。
- [ ] **Q5 通道生命週期**：目前 `CourierServer` 只有一個 `requester` 欄位。B1 須確認每個 server instance 是否嚴格對應單一遠端通道；若通道可多工，須先把 requester 與 challenge 狀態改為按 `channelPeerId` 隔離，避免身分互相覆蓋。
  - **查證（2026-10-03，T-012 乙-1）**：產品路徑上一個實例只服務一個遠端通道，但類別本身不強制。
    - `web-vue/app/composables/useCourierNode.ts` 的 `start()` 在 `connector.startListening` 回呼裡，每個入站連線各建一個 `CourierServer`，掛在該連線自己的 `P2PChannelBus`（`conn.getChannelBus()`）。
    - `RelayConnector.startListening` 以 channelId 去重（`active` 表），channelId 由 `relayChannelId` 把兩個 uid 排序相接，一條通道只有兩個參與者；`P2PChannelBus` 包一條 `RTCDataChannel`，沒有多工。
    - `CourierServer` 的 `requester`、`bytesOwed`、`inFlight` 都是單一欄位，`onEnvelope` 不比對 `env.from`。同一實例若收到多個 `from` 的封包，後到的 IDENTIFY 覆蓋先到的，未 IDENTIFY 的 `from` 可用前者身分取得報價。
    - 同一通道的對端可再送 IDENTIFY 換成另一個合法身分，現況照收（與 C6「同通道嘗試換身分須拒絕」不符）。
    - 所有實例共用同一個 `CourierStore` 與 `CourierIOUBook`，這是按房間與發票人分帳的設計，不屬於通道狀態。
    - 現況由 `tests/unit/CourierServer.channelScope.spec.ts` 釘住（6 項，其中 3 項標為現況紀錄）。產品程式未修改。

## 4. 線上格式（wire format）

本節是 v0.1 草案。文件標題的 v0.1 表示規格成熟度；線上的 `P2PEnvelope.v = 2` 是破壞性格式版本，兩者不是同一個版本欄位。Q1 至 Q5 未清空前不得標為 stable，也不得把欄位視為已實作。

### 4.1 版本協商

既有 `identify` 與 `identify-ack` 維持 `P2PEnvelope.v = 1`。支援本規格的信使在成功 `identify-ack` payload 增加可選能力欄位：

```json
{
  "ok": true,
  "capabilities": {
    "protectedRoomRead": [2],
    "legacyRoomRead": "observe"
  }
}
```

`legacyRoomRead` 只能是 `observe` 或 `enforce`。舊客戶端會忽略未知欄位。新客戶端若未看到 `protectedRoomRead` 包含 `2`，不得自動降級成 v1 `pull`／`sync`。

受保護讀取及其回覆一律使用 `P2PEnvelope.v = 2`、`ns = "courier"`。這直接沿用現有 envelope 版本欄位，但不把其他 courier v1 操作強迫升級。現行舊信使在 `src/core/relay/CourierService.ts:286` 會忽略 `v !== 1`，所以新版客戶端連到舊信使時會逾時，不會意外落回未授權讀取。

### 4.2 房籍憑證草案

```json
{
  "v": "nrm1",
  "roomId": "room-id",
  "memberNodeId": "由成員 ECDSA 公鑰導出的 node id",
  "memberPubKey": "Base64 SPKI",
  "membershipEpoch": 7,
  "issuedAt": 1788566400000,
  "expiresAt": 1788566460000,
  "issuerNodeId": "房籍權威 node id",
  "issuerPubKey": "Base64 SPKI",
  "signature": "Base64 ECDSA 簽章"
}
```

全欄位必選。`membershipEpoch` 必須是非負安全整數，`expiresAt` 必須晚於 `issuedAt`。`memberNodeId` 必須與 `memberPubKey` 綁定，`issuerNodeId` 必須與 `issuerPubKey` 綁定。Q1 尚未裁決 issuer 的信任根，Q2 尚未裁決世代來源，因此此格式目前不能單獨構成可部署授權。

### 4.3 challenge

客戶端先送 v2 `type: "pull-challenge"`：

```json
{
  "roomId": "room-id",
  "operation": "pull"
}
```

`operation` 只能是 `pull` 或 `sync`。信使只對已完成 `identify` 的通道回 v2 `type: "pull-challenge-ack"`：

```json
{
  "roomId": "room-id",
  "operation": "pull",
  "challengeId": "至少 128 位元隨機值的無填充 Base64url",
  "courierId": "信使端點 id",
  "channelPeerId": "本通道請求端的 envelope from",
  "requesterNodeId": "identify 綁定的 node id",
  "challengeExpiresAt": 1788566460000
}
```

信使須在通道本地保存 challenge 的全部欄位與未使用狀態。重新 `identify`、通道關閉、逾時或一次驗證嘗試後都須作廢。不得只把 challenge 交給無狀態驗證器後永久接受重放。

簽發 challenge 不得查詢 `serveRoom`、`roomStore` 或其他房間資料，也不得依房間存在與否改變回覆形狀或時間級距。未授權者只能得知信使支援本協議，不能藉 challenge 探測房間。

### 4.4 受保護 PULL 與 SYNC

v2 `type: "pull"` payload：

```json
{
  "roomId": "room-id",
  "authorization": {
    "challengeId": "與 challenge-ack 相同",
    "credential": {
      "v": "nrm1",
      "roomId": "room-id",
      "memberNodeId": "member-node-id",
      "memberPubKey": "Base64 SPKI",
      "membershipEpoch": 7,
      "issuedAt": 1788566400000,
      "expiresAt": 1788566460000,
      "issuerNodeId": "issuer-node-id",
      "issuerPubKey": "Base64 SPKI",
      "signature": "Base64 ECDSA 簽章"
    },
    "requestSignature": "Base64 ECDSA 簽章"
  }
}
```

v2 `type: "sync"` 保留既有 `digest`，並加入相同的 `authorization`。兩種操作的 proof 不可互換，`pull` 的 proof 不能拿去呼叫 `sync`。

成功回覆使用 v2 `records` 或 `sync-resp`，資料語義維持既有協議。拒絕時回 v2 `type: "read-denied"`：

```json
{
  "accepted": false,
  "roomId": "room-id",
  "operation": "pull",
  "reason": "identity-required"
}
```

`reason` 只能是 `identity-required`、`challenge-required`、`challenge-expired`、`challenge-replayed`、`channel-mismatch`、`membership-invalid`、`membership-expired`、`membership-epoch-stale` 或 `unsupported-version`。拒絕回覆不得含 `records`、`digest`、紀錄數量或可推導房間是否存在的差異資訊。

## 5. 密碼學語義

### 5.1 TOMBSTONE 原語的取捨

`verifyTombstone` 會先由附帶公鑰導出 `senderId`，確認它存在於該房 store 的寄件人集合，再驗 ECDSA P-256/SHA-256 簽章，位置為 `src/core/relay/TombstoneCrypto.ts:66-92`。這套公鑰綁定、ECDSA 與用途域分離方式可以重用，但 `TOMBSTONE|roomId` 的證明不能直接當作 PULL 授權。

理由有三點。第一，墓碑重放只會重複刪除，屬冪等操作；PULL 重放會持續外洩中繼資料並放大流量。第二，store 中出現過某個 `senderId` 只證明歷史寄存，不證明目前仍在籍。第三，墓碑沒有綁定請求者、通道、信使、操作、challenge 或期限。Spec 029 只沿用密碼學原語，不沿用墓碑的授權語義。

### 5.2 房籍憑證簽章

房籍權威對下列固定順序 JSON 陣列的 UTF-8 位元組取 SHA-256，再以 ECDSA P-256/SHA-256 簽章：

```text
JSON.stringify(["NERILO-ROOM-MEMBERSHIP", "nrm1", roomId, memberNodeId, memberPubKey,
                membershipEpoch, issuedAt, expiresAt, issuerNodeId, issuerPubKey])
```

信使必須驗證兩組 node id 與 SPKI 公鑰綁定、issuer 為該房受信任權威、憑證未過期、世代未落後，且 credential 的 `roomId` 與請求完全相同。任一條件未通過即 fail-closed。

### 5.3 請求證明與通道綁定

請求者以 `memberPubKey` 對應的身分私鑰簽署。序列化、雜湊與簽章程序同第 5.2 節，先對下列固定順序 JSON 陣列的 UTF-8 位元組取 SHA-256，再以 ECDSA P-256/SHA-256 簽章：

```text
JSON.stringify(["COURIER-PROTECTED-READ", 2, operation, roomId, requesterNodeId,
                courierId, channelPeerId, challengeId, challengeExpiresAt,
                SHA256(canonicalMembershipCredential)])
```

信使必須依固定順序驗證：

1. challenge 存在、尚未使用、未過期，且屬於目前 server instance 的通道。
2. `channelPeerId` 等於本次 envelope 的 `from`。
3. `requesterNodeId` 與目前通道最後一次成功 `identify` 的 requester 相同。
4. `requesterNodeId`、`memberNodeId` 及 `memberPubKey` 三者互相綁定。
5. 房籍憑證通過第 5.2 節全部檢查。
6. `operation`、`roomId`、信使、通道與 challenge 全部相符。
7. `requestSignature` 驗證成功。

驗證嘗試後立即把 challenge 標為已使用，不因驗證失敗而允許同一 challenge 重試。這可防止擷取別人的證明後換房、換操作、換通道或重送。

## 6. 狀態機與驗證時點

1. 通道建立後，客戶端以 v1 `identify` 提供 `nodeId` 與 `pubKey`。
2. 信使以 `pubKeyBindsNodeId` 驗證成功後固定 requester，並在 v1 `identify-ack` 宣告受保護讀取能力。相同身分可冪等重送；不同身分不得在同一通道覆寫既有 requester，須重建通道。
3. 每一次 `pull` 或 `sync` 都須先取得對應操作與房間的新 challenge。
4. 客戶端送出 v2 受保護讀取，附房籍憑證與 request signature。
5. 信使先完成第 5.3 節驗證。只有全部通過才能呼叫 `serveRoom` 或計算 `sync-resp`。
6. 成功或失敗後 challenge 都作廢。網路逾時代表結果未知；重試須取得新 challenge。

不採用「IDENTIFY 時驗一次，以後無條件讀所有房」的方式。IDENTIFY 只證明 requester 控制某把身分私鑰，不證明它屬於任何房間，也不能處理不同房間或房籍世代。每次讀取帶新證明會增加一次 challenge 往返與簽章成本，但能把授權綁定到實際房間、操作與通道，並阻止錄下別人的證明後重放。

## 7. 錯誤處理與相容性

### 7.1 版本組合

- **舊版信使遇到新版客戶端**：舊信使依現有 `env.v !== 1` 閘門忽略 v2。新版客戶端會逾時或改走其他信使／成員 anti-entropy，且不得自動改送 v1 讀取。
- **新版信使遇到舊版客戶端，觀察模式**：可暫時依 v1 舊行為回覆，但必須記錄 `legacy-read-observed`，並明確標示 R8 仍存在。遙測不得寫入房間原始 id、公鑰、簽章或密文。
- **新版信使遇到舊版客戶端，強制模式**：不得呼叫 `serveRoom`，不得回傳任何紀錄。信使以 v2 `read-denied` 回覆；舊客戶端因不接受 v2 而逾時，這是預期的破壞性退場行為。
- **新版信使遇到新版客戶端**：先以 v1 `identify-ack` 協商能力，再使用 v2 challenge 與受保護讀取。

### 7.2 過渡順序

1. 先部署可理解 v1 與 v2、但處於觀察模式的信使。
2. 部署只在能力協商成功後使用 v2 的客戶端。新版客戶端不得靜默降級。
3. 依 Q4 的操作者裁決檢查舊版使用量與相容期限。
4. 切換強制模式，拒絕全部 v1 `pull`／`sync`。
5. 強制模式穩定後移除觀察模式。任何延長都須回填本 spec 的期限與理由。

未知 v2 `type`、缺少必選欄位、型別錯誤、未知 proof 版本或無效 Base64 均須 fail-closed。實作可回通用 `read-denied`，但不得用錯誤差異讓未授權者判斷房間是否存在。

## 8. 安全考量

- **重放**：每次讀取使用通道本地的一次性 challenge，簽章同時綁定信使、通道端點、請求者、房間、操作、期限與房籍憑證。跨房、跨信使、跨通道及跨操作重放都必須失敗。
- **冒名**：IDENTIFY、房籍憑證與 request signature 都要做 node id 與公鑰綁定。只驗簽章而不比對 requester 不算符合。
- **歷史成員**：舊憑證的撤銷依賴 Q2 的 membership epoch。Q2 未解前不能宣稱已阻止離房成員取回後續紀錄。
- **首次權威冒用**：若 courier 只採首次看見即信任，知道 `roomId` 的攻擊者可能搶先固定假權威。Q1 未解前不得用 TOFU 當成完整房籍驗證。
- **資源耗盡**：未授權者可大量索取 challenge 或迫使信使驗 ECDSA。實作須在密碼運算前做每通道速率限制、欄位長度上限、challenge 數量上限與過期清除。確切數值由 B1 量測後回填。
- **中繼資料**：授權成功的信使仍可見 requester、roomId、操作時間、紀錄量與 senderId 集合。此規格只阻止未授權讀取，不隱藏信使本身可見的社交圖譜。
- **機密內容**：房籍憑證不含房間金鑰，request signature 也不證明持有內容金鑰。密文完整性與收端驗簽仍由既有 GossipMessage 路徑負責。
- **觀察模式**：觀察模式會繼續洩漏資料，只能用於有明確退場條件的相容過渡。沒有 Q4 裁決時不得預設開啟。

## 9. 經濟語義

本規格不新增計價，也不改 Protocol Spec 003。challenge、拒絕與成功讀取都不得自行產生點數。若未來要對 PULL／SYNC 計價，必須另行定義服務量、請求者共簽與重放防護，不能沿用寄存 bytes 直接推算。

## 10. 符合性判準（conformance）

B1 須在既有 `tests/unit/CourierService.spec.ts` 與 `tests/e2e-vue/peer-relay-complete.spec.ts` 落實下列可執行案例。Q1 至 Q5 未解前，涉及房籍權威與期限的向量保持未完成，不得以 mock 一律回傳 true 冒充符合。

- [ ] **C1 合法成員讀取**：已識別請求者持有效且最新世代的房籍憑證，完成新 challenge 簽章後，v2 `pull` 回傳該房既有密文；回傳內容逐位元組不變。
- [ ] **C2 非房成員拒絕**：已識別但沒有該房有效憑證的第三個身分送 v2 `pull` 或 `sync`，收到 `membership-invalid`；信使不得呼叫 `serveRoom`、`roomStore` 或其他房間資料讀取，回覆不含 records、digest 或紀錄量。
- [ ] **C3 通道綁定**：把合法成員在通道 A 的 proof 複製到通道 B，須以 `channel-mismatch` 或通用拒絕失敗，不得回傳紀錄。
- [ ] **C4 單次 challenge**：同一 proof 第一次成功後再次送出，須以 `challenge-replayed` 或通用拒絕失敗；信使不得第二次呼叫 `serveRoom`。
- [ ] **C5 簽章覆蓋**：改動 `roomId`、`operation`、`requesterNodeId`、`channelPeerId`、`courierId`、challenge、期限或房籍憑證任一欄位，驗證都須失敗。
- [ ] **C6 身分綁定**：IDENTIFY 的公鑰與 node id 不符、credential 的成員公鑰與 requester 不符，或同通道嘗試換身分，都須拒絕。
- [ ] **C7 世代與期限**：過期 challenge、過期 credential 與落後 `membershipEpoch` 均不得讀取。確切時間向量待 Q2、Q3 裁決後回填。
- [ ] **C8 操作完整性**：`pull` 與 `sync` 都受相同授權閘門保護；`pull` proof 不得用於 `sync`，反之亦然。
- [ ] **C9 相容矩陣**：舊信使忽略 v2 且新版客戶端不降級；新版信使觀察模式記錄 v1；強制模式對 v1 不回傳紀錄；新版雙方完成 v2 流程。
- [ ] **C10 R8 characterization 轉向**：`tests/e2e-vue/peer-relay-complete.spec.ts:387-450` 現在刻意斷言非成員可取回密文。B1 首次啟用強制模式時，這條測試預期先轉紅；同一變更必須把它改成「非成員被拒且未收到密文」的負向案例，不能刪除或改成跳過。
- [ ] **C11 不變量回歸**：合法成員補收後仍恰好一次；密文內容不變；拒絕讀取不產生點數或服務收據；既有合法 TOMBSTONE 行為不回退。

## 11. 參考實作對照與相鄰問題

- `src/core/relay/CourierService.ts:285-286`：現行只接受 envelope v1，並拒絕 `from === selfId`。
- `src/core/relay/CourierService.ts:360-366`：IDENTIFY 會驗 `pubKeyBindsNodeId` 並寫入單一 requester，但 PULL 未讀取 requester。
- `src/core/relay/CourierService.ts:431-466`：現行客戶端只有配置 `MemberCreditConfig` 時才自動 IDENTIFY。B1 須讓讀取身分與計點設定分離，不能為了 PULL 授權而解凍 ledger。
- `src/core/relay/CourierService.ts:372-376`：現行 PULL 未授權即呼叫 `serveRoom`。
- `src/core/relay/CourierService.ts:386-403`：現行 SYNC 同樣會回傳房間紀錄，也須納入受保護讀取。
- `src/core/relay/CourierService.ts:526-531,551-595`：客戶端 PULL／SYNC 沒有房籍證明或 challenge。
- `src/core/relay/CourierStore.ts:215-246`：資格檢查位於 deposit 端，不是 read 授權。
- `src/core/relay/courierEligibility.ts:20-35`：只判斷可代管的密文／keyx 形狀，不判斷請求者房籍。
- `src/core/relay/CourierStore.ts:277-287`：`serveRoom` 只接收 `roomId`，沒有 requester。
- `src/core/relay/TombstoneCrypto.ts:21-97`：可參考 ECDSA、公鑰綁定與用途域分離，不能直接沿用墓碑 proof。
- `src/core/relay/CourierReceipts.ts:52-55`：`pubKeyBindsNodeId` 的既有實作。
- `tests/unit/CourierService.spec.ts:73-100,337-379`：只有合法 pull 正向案例與 TOMBSTONE 房籍案例，沒有非房成員 PULL 被拒。
- `tests/e2e-vue/peer-relay-complete.spec.ts:387-450`：R8 characterization 現在釘住「非成員可取回」的已知缺口。
- `herdr-packets-Nerilo/A2C_characterization_20260904T080237Z.md`：R8 靜態分析與影響邊界。

### 11.1 與 R11 的關係

R8 與 R11 都是取用授權缺口，但位於不同層。R8 發生在 courier DataChannel 協議，受保護的是信使代管密文；R11 發生在 Firestore 規則與 `_joinRoomTransaction` 的首次讀取，阻止受邀者加入私有房。Spec 029 不修改 `firestore.rules`，也不定義 R11 的修法。

兩者不應綁成同一個實作或同一次部署。`firestore.rules` 隨 master push 自動部署到 production，屬操作者裁決範圍。R11 未來若建立可驗的房籍權威或邀請憑證，可以成為 Q1 的候選信任根，但必須經新的操作者裁決與 ADR，不能由本規格預先假設。Spec 029 可以先完成線上格式、challenge 綁定、相容矩陣與拒絕測試；在 Q1、Q2 沒有可信答案前，不得宣稱信使取回路徑已完成授權。

### 11.2 已知現況偏離

參考實作目前不符合 C1 至 C11。任何能向信使送 courier namespace 訊息且知道 `roomId` 的節點，仍可透過 `pull` 或 `sync` 取得該房現存密文。內容仍需房間金鑰才能解密，但房間是否有紀錄、紀錄量與 `senderId` 集合會外洩，重複讀取也能放大信使流量。這是未記錄的缺口，不是 ADR-0024 或 Spec 021 已接受的設計；Spec 029 完成前，任何報告都不得宣稱信使取回路徑已授權。

### 11.3 活文件規則

B1、B2 若發現通道模型、房籍權威或相容行為與本草案不符，須先更新本 spec 並標明取捨，再修改實作。不得以程式碼默默偏離線上格式或降低拒絕條件。
