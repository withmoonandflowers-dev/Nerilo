# Protocol Spec 031：服務債權憑證與次級市場 v0.1

- 軌別：protocol（跨實作互通層；變更視同公開 API 破壞性變更）
- 狀態：draft
- 建立：2026-09-06／最後更新：2026-09-06
- 關聯：ADR-0038（本規格的取捨）、ADR-0029（現行三方簽名轉讓）、Spec 001（信使寄存經濟）、
  ADR-0031（PARK 模組處置）、Spec 028 §9（PeerScoring 與 CourierQuality 接線）
- 基準：`7d9e723`

> 本規格的讀者是「用別的語言寫相容實作的人」。以下一律用線上格式與語義文字定義，
> 不以 TypeScript 型別當定義。

## 1. 目的與範圍

Nerilo 的節點會替彼此轉運與寄存。現行機制（Spec 001、ADR-0029）已經能記錄「誰欠誰多少」，
但那張欠條只能在原開票人親自參與時轉手，所以它是一張**不能流通的收據**，不是可交易的債權。
本規格定義可流通的服務債權憑證，以及節點之間交換這些憑證的協議。

在範圍內：
- 憑證格式（記名與可背書兩種）、三種面額、到期、背書鏈與其驗證。
- 持有人向開票人兌換服務的協議。
- 兩段式撮合協議（交換意向、配對、互相背書、逾時作廢）。
- 雙重背書的偵測、拒絕與歸屬。
- 開票人信用摘要的查詢格式。

不在範圍內（實作自由或明確不做，見 2.2）：
- 撮合服務的排序與收費策略、市場 UI、憑證的儲存後端。

## 2. 術語與邊界

### 2.1 術語

| 詞 | 意義 |
|---|---|
| 開票人（issuer） | 承諾提供服務的節點。它是自己所開憑證的唯一結算權威 |
| 持有人（holder） | 目前有權向開票人請求服務的節點 |
| 記名憑證 | 持有人固定；轉手須開票人、現持有人、新持有人三方同意（沿用 ADR-0029） |
| 可背書憑證 | 持有人可自行背書轉手，開票人不必在線；代價是雙重背書風險（見第 7 章） |
| 背書（endorsement） | 現持有人簽署的「我把這張憑證轉給某人」的一則紀錄 |
| 背書鏈 | 從開票起算、逐則相扣的背書序列 |
| 登記（registration） | 開票人（或其代理）把某條背書鏈記為該憑證的唯一有效鏈 |
| 撮合節點（matcher） | 收集交換意向並提出配對的節點。它不持有、也無法取得任何憑證 |
| 面額（denomination） | 憑證承諾的服務種類與數量單位 |

### 2.2 明確不做

- **不做法幣定價、不做法幣兌現。** 憑證只以服務單位計價，只能兌換服務。
- **不發代幣、不上公鏈、不做全域共識。** 每個開票人只對自己開的憑證負責。
- **Nerilo 不自營唯一市場。** 撮合是任何節點可跑的模組。
- **不解凍 `src/core/ledger/`。** 本規格所需的登記簿是開票人本機的獨立結構，
  與該 PARK 模組無關（`src/core/incentive/CreditLedger.ts` 是另一個模組，不在凍結範圍，
  但其 entry 語義是「點數增減」，與「背書鏈鏈頭」不同，本規格不沿用它，理由見 ADR-0038）。
- **不做市場 UI。** 本階段是純協議層與 SDK 表面。
- **不做匿名背書。** 背書鏈對開票人可見，這是結算權威的必然結果，見 8.3。

### 2.3 四條核心不變量（憲法第 4 條）

| 不變量 | 影響 | 說明 |
|---|---|---|
| 訊息恰好一次 | 無影響 | 憑證是獨立訊息類別，不改變 gossip 的送達與去重語義 |
| E2EE 機密性 | 無影響（內容層） | 憑證不承載訊息內容。但憑證本身不加密，其中繼資料揭露見 8.3 |
| 點數帳本正當性 | **直接影響，本規格的主題** | 見 2.4 |
| 身分與授權 | **有影響** | 每一次簽章驗證都必須同時檢查公鑰與 node id 的綁定，見 5.1 |

### 2.4 對「點數帳本正當性」的具體聲明

1. 沒有全域餘額。每張憑證都有具名開票人、具名面額與簽章。
2. 憑證的有效性完全由簽章鏈決定，不依賴任何節點的善意。
3. 開票人是自己憑證的唯一結算權威。**任何實作都不得接受沒有開票人（或其代理）登記的背書鏈作為已結算**。
4. 雙重背書**可偵測、可歸屬，但在沒有共識層的前提下不可預防**。本規格不掩飾這一點，見第 7 章。

## 3. 待釐清

| 編號 | 問題 | 為何不在 D0 裁決 |
|---|---|---|
| D-Q1 | 「優先權」面額的兌現語義要不要綁定具體服務等級 | 需要先有 D2 的轉運量端對端實測，才知道優先權要用什麼粒度才可驗 |
| D-Q2 | 背書鏈的長度上限與過長鏈的處置 | 上限訂太低會擋住正常流通，訂太高會讓驗證成本可被濫用；需要實測驗證成本 |
| D-Q3 | 開票人離線時的代理登記，要不要允許多個代理並存 | 多代理會把「先到先認」變成分區各自先到，見 7.3 |
| D-Q4 | 信用摘要的觀測者要不要互相背書成聚合證明 | 聚合會引入新的女巫面，需先看單一觀測者摘要的實際鑑別度 |
| D-Q5 | 憑證是否需要與 `CoSignedReceipt` 的服務證明綁定 | 現況 `claimCredit()` 沒有非測試呼叫端，綁定對象目前不在產品路徑上（見 10.2） |
| D-Q6 | `relay-bytes` 與 `priority` 要如何接到產品消費端 | 現行轉運路徑沒有配額或優先序消費端；需另行設計轉運配額排程器，不能把餘額扣減當成已履約 |
| D-Q7 | 信用摘要是否要提供 mesh RTT 中位數 | `HeartbeatService` 目前只保留最近一次 pong 的 RTT，沒有樣本序列；要算中位數必須先新增取樣保存與觀測窗語義 |
| D-Q8 | 如何累積觀測者自己的兌換互動紀錄 | 本階段沒有產品路徑記錄觀測者向其他開票人提出的兌換與履行結果，不能拿開票人自己的兌換簿替代 |
| D-Q9 | 信用摘要是否要加入硬性到期欄位 | 本版只提供觀測窗，由消費端自行判斷新鮮度；硬性到期會成為跨實作的相容規則，需另行裁決 |

### D-Q2 量測紀錄（2026-10-03，T-012 乙-2；上限未訂）

**方法**：`node scripts/measure-endorsement-chain.mjs 30 3`。腳本用 esbuild 打包 `src/core/incentive/ServiceIOU.ts` 後在 Node 執行，對鏈長 1、2、4、8、16、32、64 各建一條真簽章鏈（ECDSA P-256，每段不同簽署者），先熱身 3 次，再對同一條鏈呼叫 `verifyEndorsementChain` 30 次，計時單位為整條鏈一次完整驗證（含憑證本身的驗證）。百分位取 nearest-rank。環境：Node v26.5.0，Intel i9-8950HK 12 執行緒，量測時 load average 約 9（同機另有工作在跑，數字偏保守）。

| 鏈長 | p50 (ms) | p95 (ms) | 每段 p50 (ms) | 整條鏈 JSON (bytes) |
|---|---|---|---|---|
| 1 | 1.93 | 2.78 | 1.93 | 581 |
| 2 | 2.58 | 8.66 | 1.29 | 1,161 |
| 4 | 4.14 | 5.02 | 1.04 | 2,321 |
| 8 | 7.30 | 9.00 | 0.91 | 4,641 |
| 16 | 13.27 | 17.55 | 0.83 | 9,288 |
| 32 | 27.04 | 31.23 | 0.85 | 18,584 |
| 64 | 47.46 | 57.36 | 0.74 | 37,176 |

出處：`herdr-packets-Nerilo/runs/T12v_乙_endorsement-chain_20261003T104455Z.log`。同日較早一次（`..._20261003T104425Z.log`，無位元組欄）鏈長 64 為 p50 44.88、p95 56.45。

**觀察（已驗證）**
- 鏈長 16、32、64 的每段 p50 約 0.74 至 0.85 ms（短鏈含憑證本身的固定成本，鏈長 1、2、4、8 的每段 p50 為 1.93、1.29、1.04、0.91 ms）。
- 讀碼與呼叫計數：程式每段會驗章、匯入公鑰，並雜湊背書、公鑰及驗章資料，即每增加一段多 3 次顯式 SHA-256（`ServiceIOU.ts` 的 `endorsementHash`；`pubKeyBindsNodeId` 經 `TombstoneCrypto.senderIdFromPubKey`；驗章經 `CourierReceipts.ecdsaVerifier` 先雜湊 canonical 字串）與 1 次 ECDSA verify。各步驟的耗時占比未量測。
- 現行產品路徑沒有帶上限：`ServiceIOUCourier` 呼叫 `IssuerEndorsementRegistry.register` 與 `IssuerRedemptionBook.redeem` 時只傳 `now`，`maxChainLength` 為 undefined。`IssuerEndorsementRegistry.hydrate` 重驗已存鏈時也不帶上限。
- 現行 courier 入站線上路徑的唯一長度護欄，是 `P2PChannelBus` 的入站單幀大小上限 256 KiB（`MAX_INBOUND_MESSAGE_BYTES`）。這不代表瀏覽器 SCTP 的能力上限，也不約束直接函式呼叫或 `hydrate` 路徑。

**推論（未量測）**
- 以每段約 580 bytes 推算，256 KiB 幀約可塞 450 段，以每段 0.75 ms 推算單次驗證約 340 ms。一個對端可反覆送這種鏈讓開票人持續驗章。
- `hydrate` 重驗的成本是「已登記鏈數 × 鏈長」，上限同時決定冷啟動時間。

**建議值：16**（供操作者與使用者裁決，本版未寫進程式）
- 驗證 p95 約 17.5 ms，整條鏈約 9.3 KB（Node 量測，瀏覽器內未量）。
- 房間人數硬上限是 10，一張憑證在同一群節點間轉手 16 次已超過正常流通所需；若要讓憑證跨房流通，32（p95 約 31 ms）是次選。
- 過長鏈的處置沿用 8.2：超過即回 `malformed`，不嘗試部分驗證。

## 4. 線上格式（wire format）

所有格式以 UTF-8 JSON 表示。所有 `nodeId` 是公鑰的 SHA-256 前 32 字元（與 repo 現行
`deriveUserId` 一致）。所有 `pubKey` 是 Base64 的 SPKI ECDSA P-256 公鑰。
所有時間是 Unix 毫秒整數。所有 `nonce` 是至少 128 bit 的隨機值，Base64 或 UUID。

### 4.1 面額（denomination）

```json
{ "unit": "relay-bytes", "amount": 5242880 }
```

| `unit` | 語義 | `amount` 型別與單位 |
|---|---|---|
| `relay-bytes` | 開票人承諾為持有人轉運的密文位元組數 | 非負整數，位元組 |
| `custody-byte-days` | 開票人承諾為持有人寄存的「位元組 × 天」 | 非負整數，位元組天 |
| `priority` | 開票人承諾給予持有人的優先權授予次數 | 非負整數，次 |

`amount` 一律是整數。**不使用浮點數**：現行 `DepositIOU.amount` 是浮點點數
（`src/core/incentive/CourierIOU.ts:35-44`），跨實作累加會漂移。本規格與它不共用欄位語義，
兩者的關係見 10.1。

未知的 `unit` 一律拒絕（fail-closed），不得當作零或忽略。

### 4.2 服務債權憑證 `nsiou1`

```json
{
  "v": "nsiou1",
  "iouId": "b1f2...",
  "kind": "endorsable",
  "issuer": { "nodeId": "9f3c...", "pubKey": "MFkw..." },
  "holder": { "nodeId": "2a71...", "pubKey": "MFkw..." },
  "denomination": { "unit": "relay-bytes", "amount": 5242880 },
  "issuedAt": 1788700000000,
  "expiresAt": 1790000000000,
  "nonce": "3f9a...",
  "signature": "MEUCIQ..."
}
```

| 欄位 | 必選 | 語義 |
|---|---|---|
| `v` | 是 | 固定 `"nsiou1"`。其他值一律拒絕 |
| `iouId` | 是 | 憑證識別碼，開票人產生，對該開票人唯一 |
| `kind` | 是 | `"registered"`（記名）或 `"endorsable"`（可背書）。其他值拒絕 |
| `issuer` | 是 | 開票人的 nodeId 與 pubKey，兩者必須互相綁定 |
| `holder` | 是 | 開票時的第一手持有人 |
| `denomination` | 是 | 見 4.1 |
| `issuedAt` | 是 | 開票時間 |
| `expiresAt` | 是 | 到期時間。**必填**，不接受永不到期的憑證 |
| `nonce` | 是 | 防重放 |
| `signature` | 是 | 開票人對 5.1 的 canonical 簽章 |

`kind` 為 `"registered"` 時，持有人只能經 ADR-0029 的三方同意轉手，本規格不改那條路徑。
`kind` 為 `"endorsable"` 時，適用 4.3 的背書鏈。

### 4.3 背書 `nsend1`

```json
{
  "v": "nsend1",
  "iouId": "b1f2...",
  "seq": 1,
  "from": { "nodeId": "2a71...", "pubKey": "MFkw..." },
  "toNodeId": "7d09...",
  "prevHash": "e3b0c442...",
  "swapPairHash": null,
  "endorsedAt": 1788700500000,
  "nonce": "aa10...",
  "signature": "MEQCIF..."
}
```

| 欄位 | 必選 | 語義 |
|---|---|---|
| `seq` | 是 | 從 1 起算的連續整數 |
| `from` | 是 | 背書當下的持有人 |
| `toNodeId` | 是 | 新持有人 |
| `prevHash` | 是 | `seq == 1` 時為憑證本身的 hash（見 5.2）；否則為前一則背書的 hash |
| `swapPairHash` | 是（可為 `null`） | 非 `null` 代表這是撮合的條件背書，見 6.2。單方背書為 `null` |
| `signature` | 是 | `from` 對 5.2 的 canonical 簽章 |

### 4.4 兌換請求 `nsredeem1`

```json
{
  "v": "nsredeem1",
  "iou": { "...": "nsiou1 物件" },
  "chain": [ "...nsend1 物件，依 seq 遞增..." ],
  "claimant": { "nodeId": "7d09...", "pubKey": "MFkw..." },
  "requested": { "unit": "relay-bytes", "amount": 1048576 },
  "requestedAt": 1788701000000,
  "nonce": "cc20...",
  "signature": "MEQCIA..."
}
```

`chain` 為空陣列代表由第一手持有人直接兌換。`requested.unit` 必須等於憑證的面額單位，
`requested.amount` 必須大於零且不大於剩餘額度。部分兌換的餘額語義見 6.3。

### 4.5 交換意向 `nswapintent1`

```json
{
  "v": "nswapintent1",
  "intentId": "int-88...",
  "offer": { "iouId": "b1f2...", "issuerNodeId": "9f3c...", "denomination": { "unit": "relay-bytes", "amount": 5242880 } },
  "want": { "unit": "custody-byte-days", "minAmount": 3145728 },
  "wantIssuers": null,
  "holder": { "nodeId": "7d09...", "pubKey": "MFkw..." },
  "expiresAt": 1788702000000,
  "nonce": "dd30...",
  "signature": "MEUCIQ..."
}
```

`wantIssuers` 為 `null` 代表不限開票人；為字串陣列時只接受列出的開票人所開的憑證。
**意向不轉移任何東西**，它只是一份可驗證的報價。

### 4.6 配對提議 `nswappair1`

```json
{
  "v": "nswappair1",
  "pairId": "pair-41...",
  "intentHashes": [ "6b86b273...", "d4735e3a..." ],
  "matcher": { "nodeId": "5c1e...", "pubKey": "MFkw..." },
  "proposedAt": 1788702100000,
  "expiresAt": 1788702400000,
  "nonce": "ee40...",
  "signature": "MEQCIB..."
}
```

| 欄位 | 必選 | 語義 |
|---|---|---|
| `v` | 是 | 固定 `"nswappair1"`。其他值一律拒絕 |
| `pairId` | 是 | 本次配對提議的識別碼 |
| `intentHashes` | 是 | 兩份交換意向的雜湊，依字典序排列 |
| `matcher` | 是 | 撮合節點的 nodeId 與 Base64 SPKI 公鑰，兩者必須互相綁定 |
| `proposedAt` | 是 | 撮合節點提出配對的時間 |
| `expiresAt` | 是 | 配對提議到期時間 |
| `nonce` | 是 | 防重放隨機值 |
| `signature` | 是 | 撮合節點對 5.6 canonical 的簽章 |

`intentHashes` 依字典序排列，使兩造算出同一個 `pairId` 前置雜湊。撮合節點的簽章只表示
「這則配對由我提出」，**不賦予它任何憑證權利**。兩造可以完全忽略撮合節點另行配對。

### 4.7 信用摘要 `ncred1`

```json
{
  "v": "ncred1",
  "subjectNodeId": "9f3c...",
  "observer": { "nodeId": "2a71...", "pubKey": "MFkw..." },
  "window": { "fromMs": 1788600000000, "toMs": 1788700000000 },
  "observations": {
    "connectionAttempts": 12,
    "connectionSuccesses": 11,
    "reconcileAttempts": 9,
    "reconcileSuccesses": 9,
    "continuousReachableMs": 3600000,
    "consecutiveFailures": 0,
    "meshRttMsLatest": 84,
    "redeemRequests": 4,
    "redeemHonoured": 4,
    "doubleEndorsementsObserved": 0
  },
  "issuedAt": 1788700100000,
  "nonce": "ff50...",
  "signature": "MEQCIH..."
}
```

| 欄位 | 語義與來源 |
|---|---|
| `connectionAttempts` / `connectionSuccesses` | 觀測者本機 `CourierQualityStore` 對該節點的連線嘗試與成功次數 |
| `reconcileAttempts` / `reconcileSuccesses` | 觀測者本機 `CourierQualityStore` 對該節點的對帳嘗試與成功次數 |
| `continuousReachableMs` / `consecutiveFailures` | 觀測者本機量到的連續可達時間與連續失敗次數 |
| `meshRttMsLatest` | `HeartbeatService` 保存的最近一次 pong RTT；取不到時為 `null` |
| `redeemRequests` / `redeemHonoured` | 這位觀測者自己向 `subjectNodeId` 提出的兌換次數，以及其中被履行的次數 |
| `doubleEndorsementsObserved` | 觀測者持有、且 `from` 等於 `subjectNodeId` 的雙重背書證據筆數 |

**摘要由觀測者簽署，不是由被評價的開票人自己簽。** 自報的信用值不可驗證，
本規格不定義自報格式，收到自報摘要一律視為未驗證資料。
`meshRttMsLatest` 可為 `null`：現行 RTT 只在暖 mesh 鄰居之間存在（Spec 028 §9.1），
對只在名冊上見過的開票人取不到值，不得以任何預設值填補。
本階段沒有產品路徑累積觀測者自己的兌換互動紀錄，所以實務上 `redeemRequests` 與
`redeemHonoured` 恆為 0；呼叫端日後只有在完成 D-Q8 後才能注入非零值。

協議層不定義信用摘要的到期時間。摘要是參考資訊，不是服務義務；消費端必須依 `window`
自行決定新鮮度政策，不能把簽章有效解讀為資料仍然新鮮。

## 5. 密碼學語義

### 5.1 憑證簽章

簽章覆蓋範圍是下列固定順序陣列的 UTF-8 JSON 字串，以 ECDSA P-256／SHA-256 簽署，Base64 輸出：

```
["NERILO-SERVICE-IOU", "nsiou1", iouId, kind,
 issuer.nodeId, issuer.pubKey, holder.nodeId, holder.pubKey,
 denomination.unit, denomination.amount, issuedAt, expiresAt, nonce]
```

收端必須依序檢查，任一失敗即拒絕（fail-closed），並回報 6.4 的拒絕原因：

1. `v === "nsiou1"`，否則 `unsupported-version`。
2. 所有必選欄位存在且型別正確，`denomination.amount` 為非負整數，否則 `malformed`。
3. `issuer.pubKey` 導出的 nodeId 等於 `issuer.nodeId`；`holder` 同理，否則 `identity-mismatch`。
4. `expiresAt > issuedAt`，否則 `malformed`。
5. 以 `issuer.pubKey` 驗 `signature`，否則 `bad-signature`。
6. 驗證時點 `now` 若大於 `expiresAt`，回 `expired`。

### 5.2 背書簽章與鏈雜湊

背書簽章覆蓋範圍：

```
["NERILO-SERVICE-ENDORSEMENT", "nsend1", iouId, seq,
 from.nodeId, from.pubKey, toNodeId, prevHash,
 swapPairHash, endorsedAt, nonce]
```

`swapPairHash` 為 `null` 時，序列化為 JSON 的 `null`，不得省略該位置。

鏈雜湊定義：某一則背書的 hash 是對 `JSON.stringify([canonical, signature])` 取 SHA-256，
輸出為十六進位小寫，其中 `canonical` 是本節定義的背書 canonical 字串。
憑證的 hash 同樣對 `JSON.stringify([canonical, signature])` 取 SHA-256，輸出為十六進位小寫，
其中 `canonical` 是 5.1 定義的憑證 canonical 字串。

### 5.3 背書鏈驗證

本節只適用可背書憑證的轉手驗證。

給定憑證 `iou` 與鏈 `chain`，依序檢查：

1. `iou` 通過 5.1 全部檢查，且 `iou.kind === "endorsable"`，否則 `not-endorsable`。
2. `chain` 依 `seq` 為 1、2、3 連續遞增，無跳號無重號，否則 `chain-broken`。
3. 每一則的 `iouId` 等於 `iou.iouId`，否則 `chain-broken`。
4. `chain[0].prevHash` 等於 `iou` 的 hash；其後每則的 `prevHash` 等於前一則的 hash，否則 `chain-broken`。
5. `chain[0].from.nodeId` 等於 `iou.holder.nodeId`；其後每則的 `from.nodeId` 等於前一則的 `toNodeId`，否則 `chain-broken`。
6. 每則的 `from.pubKey` 導出 nodeId 等於其 `from.nodeId`，否則 `identity-mismatch`。
7. 每則簽章以其 `from.pubKey` 驗過，否則 `bad-signature`。
8. 每則 `endorsedAt` 不得晚於驗證時點加上 30 秒的時鐘容忍，且不得早於 `iou.issuedAt`，否則 `malformed`。
   **本規格不要求鏈內 `endorsedAt` 單調遞增**：時鐘不同步是常態，順序由 `seq` 與 `prevHash` 決定，不由時間決定。
9. `now <= iou.expiresAt`，否則 `expired`。到期後鏈不再可轉手，也不可兌換。

驗證通過後的現持有人是最後一則的 `toNodeId`；鏈為空時是 `iou.holder.nodeId`。

### 5.4 兌換請求簽章

`nsredeem1` 的簽章覆蓋範圍是下列固定順序陣列的 UTF-8 JSON 字串，以
ECDSA P-256／SHA-256 簽署，Base64 輸出：

```
["NERILO-SERVICE-REDEEM", "nsredeem1", iouHash, chainHash,
 claimant.nodeId, claimant.pubKey, requested.unit, requested.amount,
 requestedAt, nonce]
```

`iouHash` 依 5.2 的憑證雜湊定義計算。`chainHash` 的計算方式是先依鏈順序計算每則背書的
5.2 雜湊，再對 `JSON.stringify([endorsementHash1, endorsementHash2, ...])` 取 SHA-256，
輸出為十六進位小寫。空鏈的 `chainHash` 是對 JSON 字串 `[]` 取 SHA-256。

簽章必須綁定請求內的完整憑證與背書鏈。驗證端除了依 5.1 或 5.3 驗證憑證與鏈，還必須重新計算
請求內 `iou`、`chain` 的 `iouHash`、`chainHash`，確認與實際驗證的憑證及鏈相同，並檢查
`claimant.pubKey` 導出的 nodeId 等於 `claimant.nodeId`。任一不符即拒絕。

### 5.5 交換意向簽章與雜湊

`nswapintent1` 的簽章覆蓋範圍是下列固定順序陣列的 UTF-8 JSON 字串，以
ECDSA P-256／SHA-256 簽署，Base64 輸出：

```
["NERILO-SWAP-INTENT", "nswapintent1", intentId,
 offer.iouId, offer.issuerNodeId, offer.denomination.unit, offer.denomination.amount,
 want.unit, want.minAmount, wantIssuers,
 holder.nodeId, holder.pubKey, expiresAt, nonce]
```

`wantIssuers` 為 `null` 時序列化成 JSON 的 `null`；為陣列時保留線上格式中的陣列順序。
意向 hash 是對 `JSON.stringify([canonical, signature])` 取 SHA-256，輸出為十六進位小寫，
其中 `canonical` 是本節定義的交換意向 canonical 字串。

驗證端必須檢查 `holder.pubKey` 導出的 nodeId 等於 `holder.nodeId`，並以該公鑰驗證簽章。
未知面額、過期意向、身分不綁定或簽章不符都必須 fail-closed。

### 5.6 配對提議簽章與雜湊

`nswappair1` 的簽章覆蓋範圍是下列固定順序陣列的 UTF-8 JSON 字串，以
ECDSA P-256／SHA-256 簽署，Base64 輸出：

```
["NERILO-SWAP-PAIR", "nswappair1", pairId, intentHashes,
 matcher.nodeId, matcher.pubKey, proposedAt, expiresAt, nonce]
```

`intentHashes` 必須恰有兩項，並依十六進位小寫 hash 字串的 Unicode code unit 順序遞增排列。
順序不符即回 `malformed`。配對 hash 是對 `JSON.stringify([canonical, signature])` 取 SHA-256，
輸出為十六進位小寫，其中 `canonical` 是本節定義的配對提議 canonical 字串。

驗證端必須檢查 `matcher.pubKey` 導出的 nodeId 等於 `matcher.nodeId`，不符即回
`identity-mismatch`，通過後再以該公鑰驗證簽章。

### 5.7 信用摘要簽章

`ncred1` 的簽章覆蓋範圍是下列固定順序陣列的 UTF-8 JSON 字串，以
ECDSA P-256／SHA-256 簽署，Base64 輸出：

```
["NERILO-SERVICE-CREDIT", "ncred1", subjectNodeId,
 observer.nodeId, observer.pubKey, window.fromMs, window.toMs,
 observations.connectionAttempts, observations.connectionSuccesses,
 observations.reconcileAttempts, observations.reconcileSuccesses,
 observations.continuousReachableMs, observations.consecutiveFailures,
 observations.meshRttMsLatest, observations.redeemRequests,
 observations.redeemHonoured, observations.doubleEndorsementsObserved,
 issuedAt, nonce]
```

驗證端依序檢查版本、必選欄位與型別、`observer.pubKey` 與 `observer.nodeId` 的綁定及簽章。
若 `observer.nodeId` 等於 `subjectNodeId`，該摘要是開票人自報，必須視為未驗證資料並回 `malformed`。
`window.fromMs` 不得晚於 `window.toMs`。所有數值欄位都必須是非負整數，否則回 `malformed`；
`meshRttMsLatest` 另可為 JSON 的 `null`，驗證端不得把它改寫成 0 或其他預設值。
`issuedAt` 若超過驗證時點 `now` 加 30 秒的時鐘容忍，回 `malformed`。本版沒有到期檢查，
摘要的新鮮度由消費端依 4.7 的 `window` 判斷。

## 6. 狀態機與時序

### 6.1 憑證生命週期

```
issued ──endorse──> endorsed(seq=n) ──register──> registered
   │                      │                            │
   │                      └──conflict──> rejected      ├──redeem──> partially-redeemed ──> exhausted
   └──expire──> expired <──────────────────────────────┘
```

- `issued`：開票人簽出，第一手持有人持有。
- `endorsed`：持有人簽出背書。此狀態**只在持有人之間有意義**，開票人尚未承認。
- `registered`：開票人（或 7.3 的代理）已把該鏈記為唯一有效鏈。
- `rejected`：與已登記鏈在某個 `seq` 分岔，見第 7 章。
- `partially-redeemed` / `exhausted`：見 6.3。
- `expired`：`now > expiresAt`，任何狀態都會進入，且不可逆。

### 6.2 兩段式撮合

參與者：持有人 A、持有人 B、撮合節點 M（可以是 A 或 B 自己）。

1. **意向**：A 與 B 各自產生 `nswapintent1` 並送給 M。此時沒有任何轉移。
2. **配對**：M 產生 `nswappair1`，兩則意向雜湊依字典序排列，送回 A 與 B。
   A 與 B 各自重算雜湊確認 M 沒有替換內容；不符即中止。
3. **條件背書**：A 產生指向 B 的 `nsend1`，其 `swapPairHash` 等於該 `nswappair1` 的雜湊；
   B 同理。兩則條件背書互相交換。
4. **登記**：任一方把「自己收到的那則條件背書」連同「自己簽出的那則」成對送交對應開票人。
   **開票人只有在同時收到兩則、且兩則的 `swapPairHash` 相同時才登記**（見 7.2）。
5. **逾時作廢**：超過 `nswappair1.expiresAt` 仍未完成登記，兩造都必須丟棄該對條件背書，
   且開票人必須拒絕逾時後才送達的成對登記，理由 `swap-expired`。

**撮合節點拿不到憑證**：它從頭到尾只見到意向與配對，兩者都不含任何簽章授權轉移。
背書由持有人簽署且指名對方，M 無法把 `toNodeId` 改成自己而不破壞簽章。

### 6.3 兌換與餘額

- 憑證的剩餘額度初始等於 `denomination.amount`。
- 開票人收到 `nsredeem1` 並驗證通過後扣減剩餘額度，餘額為零即 `exhausted`。
- 記名憑證的兌換只做 5.1 驗證，再確認請求者等於 `iou.holder.nodeId`；可背書憑證才走 5.3。
  實作不得把記名憑證送進背書鏈驗證。
- **餘額是開票人本機狀態，不在線上格式裡**。持有人不能自行宣稱餘額；
  市場上的買方必須向開票人查詢，或承擔餘額已被消耗的風險。這是刻意的取捨，理由見 ADR-0038。
- 部分兌換不改變背書鏈；同一條鏈可多次兌換直到 `exhausted` 或 `expired`。
- 三種面額都可完成協議驗證、扣減餘額並取得兌換結果，但目前只有 `custody-byte-days` 有產品消費端。
  它會依兌換當下的擁擠價格換算成寄存點數額度。`relay-bytes` 與 `priority` 兌換成功只會扣減餘額
  並產生回執，產品行為不會因此改變。要讓這兩種面額實際影響服務，必須另做 D-Q6 的轉運配額排程器。

### 6.4 拒絕原因（closed set）

`unsupported-version`、`malformed`、`identity-mismatch`、`bad-signature`、`expired`、
`not-endorsable`、`chain-broken`、`already-endorsed-elsewhere`、`unknown-iou`、
`insufficient-balance`、`swap-incomplete`、`swap-expired`、`unknown-denomination`。

實作必須回報這組字串之一，不得自創原因碼。收到未知原因碼視同 `malformed`。

## 7. 雙重背書

### 7.1 問題

可背書憑證的持有人可以對同一個 `seq` 簽出兩則指向不同人的背書。兩則都通過 5.3 的鏈驗證，
因為它們各自的鏈都是完整的。沒有共識層就沒有辦法在簽出當下阻止這件事。

**現行 `registered` 憑證有一個結構相同但成因不同的缺口**，一併寫清楚，不要誇大也不要略過：

- 單靠現持有人**無法**雙重轉讓。轉讓草稿綁定了 `toHolderNodeId`，收受方的簿會檢查
  `transfer.toHolderNodeId !== this.ownerNodeId` 就拒絕（`src/core/incentive/CourierIOU.ts:442-444`），
  而且草稿需要開票人的 `issuerSig`（`:198-212`）。
- 但**開票人端沒有任何「這張收據已經轉讓過」的紀錄**：
  `createContributionTransferDraft` 是無狀態的純函式（`:198-212`），
  而 `repay` 的重放防護 `acceptedContributions.has(receipt.nonce)`（`:445-447`）
  只在**收受方自己的簿**內有效。
- 因此同一份服務收據若被開票人共簽進兩份指向不同收受人的轉讓，兩個收受簿會各自獨立接受，
  程式沒有任何地方會發現。目前唯一的防護是「開票人不會簽第二次」這個假設，沒有機制支撐它。

也就是說，缺的東西跟可背書憑證缺的是同一個：**開票人端的登記簿**。
D4 建的登記簿因此同時補上這一塊，不是只為新格式而建。

### 7.2 開票人先到先認

開票人為自己開出的每張憑證維護一份登記簿，內容是該憑證目前已承認的鏈頭
（`seq`、該則背書的 hash、`toNodeId`）。收到登記請求時：

1. 依 5.3 驗證整條鏈。失敗即拒絕。
2. 若該 `iouId` 尚無登記，接受，鏈頭設為該鏈最後一則。
3. 若已有登記，且新鏈是已登記鏈的**延長**（前綴完全相同、`seq` 更大），接受並前移鏈頭。
4. 若新鏈是已登記鏈的嚴格舊前綴（較短且前綴完全相同），視為冪等接受，但鏈頭維持不變，
   **絕不倒退**。否則持有人可用較短的舊鏈抹掉已登記的轉手，形成回滾攻擊面。
5. 若新鏈在任一 `seq` 與已登記鏈**分岔**（同一 `seq` 的背書 hash 不同），拒絕，
   原因 `already-endorsed-elsewhere`，並保留兩則衝突背書作為證據（見 7.4）。
6. 這次登記中，尚未被已登記前綴涵蓋的每一則條件背書（`swapPairHash` 非 `null`），
   都必須依其 `seq` 附上各自的成對 bundle，且該 bundle 的兩則背書必須有相同的 `swapPairHash`。
   缺少任一份回 `swap-incomplete`，任一份逾時回 `swap-expired`。已被登記前綴涵蓋的條件背書
   不必重附 bundle，因為它在首次納入登記時已完成驗證；重送不得重複增加驗證負擔。

### 7.3 開票人離線時的代理登記

開票人不在線時，該房的信使可代為受理登記，記下受理時序，待開票人回線後轉交。
代理**只轉達不裁決**：最終的先到先認以開票人自己的登記簿為準。

**這只縮小視窗，不消除問題。** 兩個互相分區的代理可以各自先受理一條不同的鏈；
開票人回線後只會承認其中一條，另一條的持有人手上是一張無效憑證。
任何實作都不得把代理受理呈現為「已完成轉手」。是否允許多代理並存列為 D-Q3。

### 7.4 雙重背書的歸屬

兩則同 `seq`、同 `from`、`toNodeId` 不同、且各自簽章都有效的背書，構成該持有人雙重背書的
**可轉移證明**：任何第三方拿到這兩則就能獨立驗證，不必信任提出者。
這份證據進入 4.7 的 `doubleEndorsementsObserved`，影響該節點在市場上的信用。

本規格因此的立場是：**雙重背書可偵測、可歸屬、不可預防**。這是拒絕共識層之後的必然結果，
不是實作缺陷。任何宣稱本協議能防止雙重背書的說法都是錯的。

## 8. 錯誤處理、相容性與安全考量

### 8.1 版本與相容

- 每個訊息的 `v` 是唯一的版本判準。收到未知 `v` 一律拒絕，回 `unsupported-version`，不做猜測性解析。
- 收到已知 `v` 但含未知欄位：**忽略未知欄位，但不得把它納入簽章驗證**。
  由於 canonical 是固定順序陣列而不是物件序列化，未知欄位天然不影響簽章結果。
- 破壞性變更一律跳版本字尾（`nsiou2`），新舊版本可並存；本規格不定義舊版下線時程，
  因為 v0.1 尚無部署中的相容對象。

### 8.2 資源與濫用

- 背書鏈驗證成本與鏈長成正比，攻擊者可送出超長鏈。實作必須設鏈長上限並在超過時回 `malformed`；
  上限值列為 D-Q2，本版不訂數字（沒有實測依據的數字不寫進規格）。
- 意向與配對都不轉移任何東西，所以灌爆意向只是浪費撮合節點資源，不影響憑證正當性。
  撮合節點的速率限制屬實作自由。
- 重放：憑證、背書、兌換、意向都含 `nonce`；開票人必須以 `(iouId, seq)` 拒絕重複登記，
  以 `nonce` 拒絕重複兌換。

### 8.3 中繼資料與隱私

- **背書鏈對開票人完全可見**，因為開票人是結算權威。轉手圖譜因此對開票人不是秘密。
  這是結構性結果，不是可調參數。
- 市場上的交換意向會揭露「某節點持有對某開票人的債權」，等於揭露一段過去的轉運或寄存關係。
- **開票人的身分必須穩定**，不能用一次性子金鑰：債務要能被找到才有意義，
  信用摘要也需要穩定的主體。持有人端理論上可用一次性子金鑰，
  但那會破壞 repo 現行到處都在用的 pubKey→nodeId 綁定，本版不做。
- 盲簽章可以讓開票人看不見轉手圖譜，但它與「先到先認」的雙重背書防護直接衝突，本版不做。

### 8.4 法規邊界

- 本協議的面額只有服務單位，沒有法幣欄位，也沒有任何兌換法幣的訊息。
- 官方撮合實作禁止法幣定價。
- **協議層無法阻止第三方在協議外以法幣為這些憑證定價或交易。** 這一點如實寫在這裡，
  不宣稱協議能防止它。任何對外文件都不得把「禁止法幣定價」寫成「不可能以法幣交易」。

## 9. 符合性判準（conformance）

別的實作跑得過下列向量即相容。每一條都要有正向與負向案例，負向不少於正向。

- [ ] C1：合法 `nsiou1` 被接受；`v` 改成 `nsiou2` 回 `unsupported-version`；
      `issuer.pubKey` 換成別人的回 `identity-mismatch`；改任一簽章覆蓋欄位回 `bad-signature`；
      `expiresAt` 早於 `now` 回 `expired`。
- [ ] C2：三種 `unit` 各自可簽可驗；未知 `unit` 回 `unknown-denomination`；
      `amount` 為負數或非整數回 `malformed`。
- [ ] C3：長度 3 的合法背書鏈通過；抽掉中間一則回 `chain-broken`；
      把某則的 `prevHash` 改掉回 `chain-broken`；
      某則的 `from` 不等於前一則的 `toNodeId` 回 `chain-broken`；
      對 `registered` 憑證做背書回 `not-endorsable`。
- [ ] C4：同 `seq` 的兩條分岔鏈，先到者被登記，後到者回 `already-endorsed-elsewhere`；
      已登記鏈的延長被接受；重送同一條鏈不產生第二筆登記。
- [ ] C5：兩造條件背書成對送達且 `swapPairHash` 相同時登記成功；
      只送一則回 `swap-incomplete`；超過 `expiresAt` 後送達回 `swap-expired`；
      重送已完成的配對不產生第二次轉移。
- [ ] C6：撮合節點把 `nswappair1` 的 `intentHashes` 改掉時，兩造重算雜湊會發現並中止。
- [ ] C7：兌換 `custody-byte-days` 面額後，持有人原先因額度不足被拒的寄存會被接受；
      金額超過剩餘額度回 `insufficient-balance`；
      非現持有人提出兌換回 `chain-broken`；重放同一 `nonce` 的兌換被拒。
- [ ] C8：`ncred1` 由觀測者簽署可驗；改 `observer` 回 `identity-mismatch`；
      `meshRttMsLatest` 為 `null` 時仍可驗且不得被補成任何預設值。

## 10. 參考實作對照與已知偏離

### 10.1 與現行 `CourierIOU` 的關係

現行 `DepositIOU`（`src/core/incentive/CourierIOU.ts:35-44`）有 `amount` 但**沒有面額單位、
也沒有到期日**，`amount` 是浮點點數。本規格的 `nsiou1` 是另一個格式，不是它的版本升級：
兩者並存，`DepositIOU` 繼續服務現行的寄存計價路徑，`nsiou1` 服務可流通的服務債權。
何時把前者收斂到後者，不在本階段決定。

### 10.2 已知偏離與尚未接線處

- `CoSignedReceipt` 的 `claimCredit()` 在 `7d9e723` 沒有非測試呼叫端，
  產品的 `CourierServer` 拿到的 `credit` 是 `undefined`（`web-vue/app/composables/useCourierNode.ts:268-278`）。
  因此本規格的兌換不以服務收據為前提，列為 D-Q5。
- `PeerScoring` 自 `80435a6` 起才真的登記鄰居（Spec 028 §9.2），
  在那之前沒有累積任何資料，所以 4.7 的觀測窗不應早於該時點。
- `CourierQuality` 只存在於頁面生命週期（Spec 028 §9.3.4），重載即歸零，
  所以 `ncred1` 的觀測窗實際上很短。摘要的鑑別度受此限制，不得誇大。
- `HeartbeatService` 只保存暖 mesh 鄰居最近一次 pong 的 RTT，沒有樣本序列，因此 4.7 只能提供
  `meshRttMsLatest`，不能計算中位數。若要中位數，必須先完成 D-Q7 的取樣保存與觀測窗設計。
- 對只在名冊上見過、沒有同房成為暖 mesh 鄰居的開票人，`meshRttMsLatest` 恆為 `null`。
  市場上多數陌生開票人會落在這一類。加上短暫的品質觀測窗，這份摘要的鑑別度有限，
  **不得對外宣稱它是可靠的信用評等**。
- 本階段沒有產品路徑累積觀測者向其他開票人的兌換互動，因此 `redeemRequests` 與
  `redeemHonoured` 實務上恆為 0，見 D-Q8。開票人自己的 `IssuerRedemptionBook` 不可拿來替代，
  否則會把自報資料偽裝成第三方觀測。
- 信用摘要沒有硬性到期，舊摘要可被無限期重放。消費端若不依 `window` 自訂新鮮度政策，
  就可能被舊資料誤導；是否加入協議層到期欄位列為 D-Q9。
- 市場 UI 未做，本階段只有協議層與 SDK 表面。
