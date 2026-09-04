# Protocol Spec 030：陌生人介紹入場與雙向備援 v0.1

- 軌別：protocol（介紹憑證新增跨實作線上格式、驗證與版本相容規則）
- 狀態：clarifying
- 建立：2026-09-05／最後更新：2026-09-05
- 關聯：ADR-0032、Spec 005、Spec 027、Spec 028 R11、Protocol Spec 007、Protocol Spec 029

> 本規格的目標讀者包含以其他語言實作相容入場與 signaling 的人。線上格式與狀態語義是規範；TypeScript、Vue 與 Firebase 路徑只標示參考實作現況。

## 1. 目的與範圍

本規格把 ADR-0032 的成員間加密 signaling 擴充到陌生人入場，並定義 warm 介紹與本地 HTTP rendezvous 的雙向備援。陌生人第一次接觸仍須使用目錄、既有成員提供的邀請或本地會合點之一。瀏覽器無法在沒有任何會合資訊的情況下直接找到另一個瀏覽器，本規格不宣稱零會合點的首次配對。

本規格走 protocol 軌。介紹憑證會新增跨實作交換的欄位、簽章、拒絕原因及版本相容行為。依憲法第 15 條，這類變更視同公開 API 的破壞性變更，不能只以 Vue 內部型別定義。

現況沒有房主專屬的介紹限制。有效路徑同時受兩層條件約束：`src/services/meshIdentityRegistry.ts:73-74` 只接受房內 participant 作為 `introducedBy`；`src/core/p2p/SigRelayRouter.ts:240-252` 只把信封轉給目標的直連且已開啟暖鄰居，hop 上限為 1。因此「任一在線成員都能介紹」目前沒有保證。能完成 warm 介紹的是目前仍在房籍內，且當下有可用開啟 link 的節點。

`src/core/p2p/InviteRendezvous.ts:71-95` 的 `nrz1` 解析器只驗版本、型別與非空字串，沒有介紹憑證或授權拒絕條件。`src/core/mesh/MeshGossipManager.ts:357-423` 與 `src/core/p2p/WarmColdSignalingTransport.ts:66-131` 只有 warm 優先、失敗後黏著單一 cold 的骨架，沒有 cold 失敗後重新選 warm。`src/sdk/httpSignaling.ts:28-56` 的 HTTP `send` 失敗會直接拋錯。這些都是 B1、B2 尚未實作的偏離，不得寫成既有能力。

### 1.1 四條核心不變量

- **訊息恰好一次**：本規格只處理入場授權與 signaling 選路，不改聊天訊息的 `messageId`、序號或去重語義。跨後端重送只可重送 signaling，不能直接重放聊天密文。建立連線後仍須通過既有恰好一次測試。
- **E2EE 機密性**：介紹憑證不含房間內容金鑰。SDP 與 ICE 仍依 Protocol Spec 007 對收端 ECDH 加密並由發起方 ECDSA 簽章。介紹人與 rendezvous 只能搬運密文，不能解密或修改內容。入場完成後，房間金鑰仍由既有 keyx 路徑成對分發。
- **點數帳本正當性**：無影響。本規格不計價、不產生服務收據，也不解凍 ledger。路徑切換與拒絕不得自行建立點數或欠條。
- **身分與授權**：直接收緊。介紹資格分為「簽發者目前在房籍內」與「承載節點有可用路徑」；陌生人必須證明控制憑證指定的身分私鑰，且在私有房完成權威房籍更新後才能進入 mesh。知道 `roomId`、持有未簽章的 `nrz1` 或能連到 rendezvous，都不能單獨構成新介紹協議的入場授權。

### 1.2 目標函數

- **補助競爭力**：加分。三種入場路徑與故障切換都有可重跑證據，不以簡報文字代替實測。
- **可維運**：加分。資格、拒絕、後端健康狀態與相容退場皆有明文規則。
- **可嵌入**：加分。憑證與狀態機不依賴 Vue、Firebase 或 TypeScript，其他實作可跑相同測試向量。
- **隱私韌性**：加分。會合服務只搬運加密資料；中央 signaling 不可用時，已建立的 warm 路徑或本地 rendezvous 可提供有界備援。

## 2. 術語與邊界

### 2.1 術語

- **簽發者（issuer）**：簽發介紹憑證，且在驗證當下仍屬該房 participant 的成員。
- **承載介紹人（carrier）**：實際轉送入場或 signaling 信封的暖鄰居。它可以與簽發者不同，不因代轉而取得授權權力。
- **陌生人（subject）**：尚未取得該房權威房籍，並請求入場的身分。
- **介紹憑證（introduction credential）**：把房間、subject 身分、issuer 身分、期限與一次性 nonce 綁在一起的簽章資料。
- **持連結入場**：T-003 已修復的既有流程。已驗證使用者持有房間 URL 後，由 `RoomService.joinRoom` 自行加入。現況是 bearer 型能力，與本規格的 subject-bound 介紹憑證不同。
- **目錄入場**：目錄只負責找到房間或可聯絡的成員；最終仍須通過本規格的入場授權，目錄資料本身不是憑證。
- **warm 路徑**：經已開啟的 peer link 搬運 Protocol Spec 007 密文信封。
- **cold 路徑**：沒有可用 warm 路徑時使用的 HTTP rendezvous signaling 與 directory 組合。
- **權威房籍**：決定某 UID／node id 是否已獲准加入房間的名冊。HTTP rendezvous 的暫存 participants 不是一般房間的權威房籍。

### 2.2 明確不做

- 不解凍 super-node，也不改房間容量上限。
- 不解凍 ledger，不改點數、欠條、計價或收據。
- 不解凍 `src/core/relay/onion/`。
- 不放寬 `firestore.rules` 的讀取規則。
- 不做實體裝置場測。本階段只以隔離 browser context 與可控制的網路故障測試。
- 不把無認證 rendezvous 的「知道 room id 即可加入」當作一般房間授權。
- 不把 Protocol Spec 029 的信使 PULL 房籍授權寫入本規格。
- 不改提案原稿或 `送件檔/`。

## 3. 待釐清

- [ ] **Q1 私有房的權威入籍寫入**：本規格要求介紹憑證先通過驗證，再由權威房籍記錄 subject。現行 Firestore self-join 是持連結者自行加入，沒有可驗 ECDSA 介紹憑證的寫入閘門。本階段不裁決，也不修改 Firestore 規則。後續實作須決定受限的入籍寫入機制，且不得放寬私有房讀取。沒有此裁決時，介紹憑證只能做 protocol 驗證，不能宣稱已強制私有房授權。
- [x] **Q2 nonce 的全房消耗狀態，本階段處置**：本階段不實作跨驗證者 nonce 收斂，只提供單一驗證者的重放檢查，並要求相同房間、nonce 與 subject 的重複入籍冪等。不同驗證者仍可能各自接受同一憑證，因此不得宣稱已阻止跨驗證者的流量放大。完整收斂依賴 Q1 的權威房籍或可驗簽章 gossip，留待後續規格更新。
- [x] **Q3 Vue 的 rendezvous 設定來源**：位址固定依序取自邀請資料的 `nrz1.rendezvousUrl`、使用者在 waiting UI 保存的輸入、`VITE_RENDEZVOUS_URL` 部署設定。每層都只接受不含帳密的 `http` 或 `https` URL，不把測試位址寫死進產品。三者皆無有效值時不啟用 HTTP cold，維持既有 Firestore cold。
- [ ] **Q4 離線入籍後的房籍合併**：Firestore 不可達時，已在房內的成員可依本規格驗證 subject，但離線核准如何在恢復連線後與 Firestore 權威房籍合併尚未定位。衝突、撤銷與舊快照不得以最後寫入者勝出處理。B2 在本題完成前只能驗 signaling 可達，不得宣稱跨後端房籍已完整收斂。
- [ ] **Q5 HTTP cold 故障後重選 warm**：現行 selector 只有 warm 失敗後黏著單一 cold，HTTP `send` 失敗會直接拋錯。本階段不新增 cold 到 warm 的重選。後續須先定義失敗偵測、可重選條件、單次操作上限與防抖，再做 characterization 與實作；不得以無界 retry 或加長逾時掩蓋故障。

## 4. 線上格式（wire format）

本節定義草案版本 `nintro1`。`nrz1` 保留為現有邀請會合格式，但不能當作 `nintro1` 憑證。介紹控制訊息必須放在 Protocol Spec 007 的加密 payload 中，或另一個提供相同端點機密性與來源完整性的通道中。rendezvous 只搬運封包，不驗房籍，也看不到憑證明文。

### 4.1 能力宣告

支援本規格的節點在已驗證 signaling payload 中宣告：

```json
{
  "entryAuth": ["nintro1"],
  "fallback": ["warm", "http-rendezvous"]
}
```

能力宣告不是入場授權。沒有共同的 `entryAuth` 版本時，新版節點不得移除憑證後靜默退回未授權介紹。

### 4.2 介紹憑證

```json
{
  "v": "nintro1",
  "roomId": "room-id",
  "scope": "room-entry",
  "subject": {
    "uid": "invitee-uid",
    "nodeId": "由 subject ECDSA 公鑰導出的 node id",
    "pubKey": "Base64 SPKI",
    "ecdhPubKey": "Base64 SPKI"
  },
  "issuer": {
    "uid": "member-uid",
    "nodeId": "由 issuer ECDSA 公鑰導出的 node id",
    "pubKey": "Base64 SPKI"
  },
  "issuedAt": 1788566400000,
  "expiresAt": 1788566700000,
  "nonce": "至少 128 位元隨機值的無填充 Base64url",
  "signature": "Base64 ECDSA 簽章"
}
```

全部欄位必選。`expiresAt` 必須晚於 `issuedAt`，且差值不得超過 300,000 ms。驗證端可容許最多 30,000 ms 的時鐘偏差。`subject.nodeId` 與 `issuer.nodeId` 都必須和各自 `pubKey` 綁定。`scope` 只接受 `room-entry`，不能拿來授權聊天內容、房間金鑰、信使 PULL 或其他房間。

介紹憑證是 subject-bound。一般分享用 `nrz1` 在產生時不知道收件者身分，不能直接升格成 `nintro1`。陌生人須先透過目錄、`nrz1` 指定的成員或本地 rendezvous 送出自己的身分資料，房內成員才能回傳只對該 subject 有效的憑證。

### 4.3 subject 持鑰證明

驗證者回覆一次性 challenge：

```json
{
  "v": "nintro-challenge1",
  "roomId": "room-id",
  "verifierNodeId": "current-member-node-id",
  "challenge": "至少 128 位元隨機值的無填充 Base64url",
  "expiresAt": 1788566430000
}
```

subject 回覆：

```json
{
  "v": "nintro-proof1",
  "credential": { "v": "nintro1" },
  "verifierNodeId": "current-member-node-id",
  "challenge": "與 challenge 相同",
  "challengeExpiresAt": 1788566430000,
  "signature": "subject 對第 5.2 節 canonical 資料的 Base64 ECDSA 簽章"
}
```

challenge 最長有效 30,000 ms，只能驗證一次，且須綁定當前加密通道、驗證者與 `roomId`。任何驗證嘗試後都作廢。這個 proof 防止只錄下別人的憑證後改由另一個身分使用。

### 4.4 路徑狀態事件

實作對每個 `roomId + remoteNodeId` 維護下列互通狀態，事件名稱可以映射到語言內部型別，語義不得改變：

```json
{
  "v": "nroute1",
  "path": "warm",
  "state": "available",
  "reason": "open-link",
  "observedAt": 1788566400000
}
```

`path` 只能是 `warm` 或 `http-rendezvous`；`state` 只能是 `available`、`degraded` 或 `unavailable`。`reason` 至少支援 `open-link`、`no-open-link`、`nack`、`timeout`、`network-error`、`http-error` 與 `cooldown`。這是本機選路狀態，不得被遠端自報取代，也不能當作房籍證明。

## 5. 密碼學語義

### 5.1 憑證簽章

issuer 對固定順序 JSON 陣列的 UTF-8 位元組取 SHA-256，再以 ECDSA P-256/SHA-256 簽章：

```text
JSON.stringify(["NERILO-INTRODUCTION", "nintro1", roomId, "room-entry",
                subject.uid, subject.nodeId, subject.pubKey, subject.ecdhPubKey,
                issuer.uid, issuer.nodeId, issuer.pubKey,
                issuedAt, expiresAt, nonce])
```

驗證端須確認 issuer 簽章、兩組 node id 與公鑰綁定、房間與期限，並用其已信任的權威房籍快照確認 issuer 在驗證當下仍是 participant。介紹人可能是不可信 carrier；它沒有 issuer 私鑰，無法改 subject、房間或期限。這項憑證解決誰有資格被引進，不重複 Protocol Spec 007 已提供的 SDP 機密性與完整性。

### 5.2 subject proof

subject 對下列固定順序 JSON 陣列簽章：

```text
JSON.stringify(["NERILO-INTRODUCTION-PROOF", "nintro-proof1", roomId,
                verifierNodeId, challenge, challengeExpiresAt,
                SHA256(canonicalIntroductionCredential)])
```

驗證端須先驗 challenge，再以憑證內 `subject.pubKey` 驗 proof。憑證與 proof 的 subject 必須等於即將寫入權威房籍及註冊 mesh identity 的 UID／node id。驗證成功不會自動授予房間金鑰；keyx 仍須在權威入籍完成後執行。

## 6. 介紹資格、入場授權與拒絕

### 6.1 誰可以介紹

任何目前在權威房籍內的成員都可以簽發 `nintro1`，不要求房主身分。簽發資格須在接受時再查一次，離房或遭移除的 issuer 所持舊憑證一律拒絕。

能承載 warm 介紹的節點還須有到下一跳的直連且已開啟 link，並遵守 ADR-0032 的 hop 上限 1。僅顯示在線但沒有該 link 的成員不能完成代轉。這個限制在 B1 接受為真實能力邊界：選路器先回 `no-open-link`，再依第 7 節嘗試 HTTP rendezvous；兩條都不可用時顯示無可用入場路徑，不得把「在線」報成「可介紹」。

### 6.2 持連結與經介紹進入私有房

兩者不是同一套授權：

- **持連結入場**沿用 T-003 的現況。知道房間 URL 的已驗證使用者以自己的 UID self-join。這是相容路徑，沒有 `nintro1` 的 subject 綁定、期限與 nonce，安全性較弱。
- **經介紹入場**必須先驗 `nintro1` 與 subject proof，再完成 Q1 所定的權威入籍寫入。未成功寫入前，不得註冊 mesh identity、取得房間金鑰或把 rendezvous participants 當作正式房籍。

本規格不把既有 bearer 連結的權限暗中擴張為介紹憑證，也不以 client-only 驗證冒充伺服器端房籍強制。是否淘汰私有房的 legacy link 入場須另行裁決與遷移。

### 6.3 拒絕條件

下列任一條成立都須 fail-closed，且不得建立 mesh identity 或分發房間金鑰：

1. 未知版本、缺欄位、型別錯誤、無效 Base64 或欄位超過實作上限。
2. `roomId`、scope、subject 或 verifier 與當前請求不符。
3. issuer 或 subject 的 node id 與公鑰不綁定，或任一簽章失敗。
4. issuer 在驗證當下不屬權威房籍。
5. 憑證尚未生效、已過期、壽命超過 300,000 ms，或 challenge 已過期。
6. nonce 或 challenge 已使用，或 proof 來自另一條通道、另一個驗證者或另一個房間。
7. 私有房尚未完成權威入籍寫入。
8. 房間已關閉、容量已滿或 subject 已被明確撤銷。

對外拒絕原因只能是 `unsupported-version`、`malformed`、`identity-mismatch`、`issuer-not-member`、`credential-expired`、`proof-invalid`、`replayed`、`room-unavailable`、`room-full`、`admission-pending` 或 `no-route`。未授權者不應從細部差異探測私有房名冊。

## 7. 狀態機、雙向備援與防抖

### 7.1 入場狀態機

1. subject 透過目錄、既有 `nrz1` 指定的成員或本地 rendezvous 取得第一個可聯絡端點。這一步只發現路徑，不授權入場。
2. subject 送身分與能力。房內 issuer 確認自己仍在房籍後簽發 `nintro1`。
3. 一名已在房內的 verifier 送出短效 challenge。subject 回傳憑證與 proof。
4. verifier 依第 6.3 節驗證，並依 Q1 的受限機制完成權威入籍。
5. 入籍成功後才登錄 mesh identity、執行 keyx 並建立聊天連線。入籍失敗時不分發金鑰。

### 7.2 介紹人不在，改走本地會合點

`MeshGossipManager.buildWarmColdFactory` 的 warm 優先骨架可以沿用。本階段的 Vue 房間仍以 Firestore directory 作權威名冊，只依 Q3 選出的位址建立 `createHttpSignaling` 並注入 `MeshChatService` 的 cold factory。沒有有效位址時傳入 `undefined`，由 `MeshGossipManager` 動態載入原本的 Firestore signaling。這讓 HTTP 只承載 signaling，不會在 Q4 未決時把無認證 HTTP participants 當成正式房籍。

完全本地的 Spec 027 rendezvous app 仍可同時注入 `createHttpSignaling` 與 `createHttpRoomDirectory`。它是獨立的信任區網模式，不能外推成一般 Firestore 房的權威入場模型。

warm 仍依 ADR-0032 使用 20 秒有界耐心與 NACK。沒有開啟 link，或 warm 在耐心窗內持續 NACK／逾時後，當次 signaling 才可切到 HTTP cold。rendezvous 只搬運 Protocol Spec 007 與本規格的加密 payload；其無認證 participants 不得覆蓋權威房籍。

### 7.3 會合點故障，改走介紹

這個方向目前尚未實作，並登記為 Q5。本階段若 HTTP cold 的 `send` 失敗，維持現行拋錯，不回頭重試 warm。失敗偵測、重選與防抖的數字須先由後續 characterization 決定；原先的 3,000 ms、5,000 ms 與 10,000 ms 只是假設，沒有實跑依據，從本版規格撤回。不得把「介紹人不在可退 HTTP」寫成「HTTP 掛了也會自動走介紹」。

### 7.4 房間與名冊銜接

- 邏輯 `roomId` 跨 Firestore、warm 與 HTTP rendezvous 保持逐位元一致，不建立後端專屬房間別名。
- Firestore 或 Q1 選定的替代權威保存正式房籍。HTTP directory 的 participants 只代表暫時可達節點。
- 每個後端搬運同一份 `nintro1` 與 subject proof，不因切路而重新簽發較弱的憑證。
- 後端快照衝突時 fail-closed。不得以 rendezvous 的後到資料覆蓋權威名冊；離線合併依 Q4 後續裁決。

## 8. 錯誤處理、相容性與安全考量

### 8.1 版本相容

- 新版解析器可讀既有 `nrz1`，但只把它視為 legacy 持連結會合資訊，不標記為已授權介紹。
- 支援 `nintro1` 的雙方依第 4.1 節協商。舊節點不認得能力或控制訊息時，新節點須顯示不相容，不能剝除憑證後重送。
- 破壞性欄位或 canonical 簽章範圍變更須升為 `nintro2`。未知主版本一律拒絕。
- 過渡期可以同時保留 T-003 的 legacy link 入場與 `nintro1`，但產品與報告須分開標示兩者。何時停用 legacy 私有房 link 須另行裁決。

### 8.2 安全考量

- **不可信介紹人**：carrier 可以丟棄、延遲或觀察連線 metadata，但 Protocol Spec 007 保護 SDP，`nintro1` 保護入場對象與資格。兩者解決不同問題。
- **重放**：subject 綁定、短效憑證、challenge 與本機 nonce 檢查可阻止一般跨身分重放。同一 subject 的重複入籍須冪等；本階段沒有跨 verifier 收斂，不得宣稱已阻止跨驗證者的流量放大。
- **女巫與資源耗盡**：未授權 subject 可大量要求 challenge 或簽發。實作須在驗簽前限制欄位大小，並對每個通道與 room 設有界速率。確切上限由 B1 characterization 回填。
- **中繼資料**：issuer 與 verifier知道 subject 想加入哪個房；rendezvous 可見傳輸端點、時間與密文大小。隱藏社交圖譜不在本規格範圍。
- **過期房籍**：verifier 若只持離線舊快照，可能接受已離房 issuer。Q4 未解前，離線情境只能報告已驗 signaling 備援，不能報告已驗完整授權。

## 9. 符合性判準與階段 B 驗收

### 9.1 協議負向與相容測試

B1 須將下列案例落在 `tests/unit/InviteRendezvous.spec.ts`、新的 introduction credential 純模組測試，以及 `tests/unit/SigRelayRouter.spec.ts`。不能以 mock 固定回傳通過取代簽章與房籍判定。

- [ ] **C1 合法介紹**：目前仍在籍的 issuer 簽發 subject-bound 憑證；subject 以正確私鑰完成指定的新 challenge 後，純協議驗證通過。Q1 未決前不把這項結果寫成權威入籍成功。
- [ ] **C2 非成員簽發者**：issuer 不在 participants，拒絕為 `issuer-not-member`，不寫房籍、不註冊 mesh identity、不分發 keyx。
- [ ] **C3 冒名 subject**：複製合法憑證但用另一把私鑰簽 proof，拒絕為 `proof-invalid`。
- [ ] **C4 改欄位**：改 room、subject、issuer、期限、nonce 或 scope 任一欄位，簽章驗證失敗。
- [ ] **C5 重放與過期**：已使用 nonce、已使用 challenge、過期憑證與跨房 proof 全部拒絕。
- [ ] **C6 無路**：成員顯示在線但沒有到目標的開啟 link，不能回報介紹成功；HTTP 也不可用時須在有界時間內回 `no-route`。
- [ ] **C7 相容矩陣**：新版可辨識 `nrz1` 的 legacy 語義；舊版遇 `nintro1` 不會誤接受；新版之間可完成能力協商。
- [ ] **C8 不可信 carrier**：carrier 改 introduction credential 或 Protocol Spec 007 信封任一受簽欄位，收端拒絕且不建立連線。

單元驗證指令：

```sh
npx vitest run tests/unit/IntroductionCredential.spec.ts tests/unit/InviteRendezvous.spec.ts tests/unit/RendezvousConfig.spec.ts tests/unit/HttpRendezvousCold.spec.ts tests/unit/SigRelayRouter.spec.ts tests/unit/MeshWarmColdFactory.spec.ts
```

及格線：題列既有案例與 B1 新增的 C1 至 C8 全數通過，0 個 skip，exit code 0。

### 9.2 三種入場路徑

三條 E2E 必須各自建立一個原本不在 participants 的 browser context，依該路徑完成現有入場、進入 `/chat/` 並和既有成員交換一則 E2EE 訊息。只看到房間或只完成 signaling 不算入場成功。Q1 未決前，介紹路徑的結果只能標為現況 characterization，不能標為 `nintro1` 權威授權驗收。

```sh
npx playwright test --config playwright.vue.config.ts tests/e2e-vue/stranger-entry.spec.ts --workers=1
npx playwright test --config playwright.rendezvous.config.ts tests/e2e-rendezvous/rendezvous-app.spec.ts --workers=1
```

及格線：`stranger-entry.spec.ts` 的公開與私有目錄／素連結、非房主成員介紹公開與私有房共 4/4 通過；既有 `rendezvous-app.spec.ts` 的本地會合 1/1 通過。全部 0 個 retry、0 個 skip，每個指令 exit code 0。現行介紹 E2E 是 characterization，證明不看 ownerUid 與加密中繼會動，不證明 `nintro1` 已接上權威入籍。本地會合案例證明 HTTP 可成房，也不外推為一般房間授權。

### 9.3 斷 WAN 與雙向故障

本階段沿用 `tests/e2e-rendezvous/rendezvous-app.spec.ts` 驗證本地 HTTP 會合可達，沒有新增斷 WAN 測試，也沒有實作 HTTP cold 失敗後重選 warm。完整雙向故障驗收須等 Q4、Q5 補齊後再定義可執行指令與及格線。在此之前不得宣稱斷 WAN 入籍或雙向自動切換已驗證，也不得把瀏覽器模擬寫成兩台實體裝置場測。

### 9.4 p2p2p introduction 穩定度

```sh
npx playwright test --config playwright.vue.config.ts tests/e2e-vue/p2p2p-introduction.spec.ts --workers=1 --repeat-each=3
```

及格線：3/3 通過，0 個 retry，0 個 skip，exit code 0。三輪都須保留既有斷言：介紹 pair 經加密中繼、carrier 有轉送證據、被介紹 pair 不退到未指定的 cold。Spec 005 記錄的既有歷史是同一支測試三連綠，不能把 3/3 說成三種入場路徑。

## 10. 參考實作對照與已知偏離

- `src/core/p2p/InviteRendezvous.ts`：`nrz1` 新增選填 `rendezvousUrl` 並限制為不含帳密的 `http(s)` URL；它仍是路徑提示，不是介紹憑證。
- `src/core/p2p/IntroductionCredential.ts`：已實作 `nintro1`、subject proof、拒絕原因與本機冪等追蹤的純協議簽驗，尚未接上權威入籍。
- `web-vue/app/lib/rendezvousConfig.ts`：實作 Q3 三層來源與 URL 正規化，不保存測試專用預設值。
- `web-vue/app/pages/waiting/[roomId].vue`：接收邀請位址、提供使用者輸入，並把有效位址放入分享連結。R11 加入前讀取修法保留。
- `src/services/meshIdentityRegistry.ts:50-80`：現行只在登錄時檢查 writer 與 `introducedBy` 是否在 participants，未驗介紹憑證。
- `src/core/p2p/SigRelayRouter.ts:69-121,223-256`：現行 carrier 由開啟 links 決定，hop 上限 1；沒有入場資格判定。
- `src/core/mesh/MeshGossipManager.ts:357-423`、`src/core/p2p/WarmColdSignalingTransport.ts:66-131`：只有 warm 到單一 cold 的退守，沒有 cold 到 warm 的健康重選。
- `src/sdk/httpSignaling.ts:21-121`：HTTP signaling 與 directory 可注入，但 rendezvous 無認證，send 失敗直接拋錯。
- `web-vue/app/pages/chat/[roomId].vue`：有有效 Q3 位址時注入 HTTP signaling factory，否則保留 Firestore cold；directory 仍用 Firestore，Q4 未解前不做跨後端房籍合併。
- `tools/rendezvous-server.mjs:3-13,68-149`：本地會合點沒有帳號與房籍授權，participants 不可直接升格為權威房籍。
- `tests/e2e-vue/p2p2p-introduction.spec.ts:50-141`：現有單一三 context 介紹案例，未涵蓋 `nintro1` 或三種入場路徑。

### 10.1 B1、B2 實作順序

1. 本階段 B1 已新增純協議模組、拒絕向量與現況 E2E 回歸鎖。Q1 未決，因此沒有接權威入籍，也不得宣稱私有房介紹授權已強制。
2. 本階段 B2 已依 Q3 注入可選 HTTP signaling cold。Q4 未決，因此沒有替換 Firestore directory；Q5 未決，因此沒有新增 cold 到 warm 重選與防抖。
3. 每次實作若發現本規格的通道、權威或時序假設不成立，先更新本 spec 與 ADR，再修改程式。不得默默降級成無憑證入場。
