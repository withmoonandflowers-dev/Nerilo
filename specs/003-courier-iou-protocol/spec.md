# Protocol Spec 003：信使報價與有對象欠條 v1

- 軌別：protocol（跨實作互通層；變更視同公開 API 破壞性變更）
- 狀態：stable
- 建立：2026-07-16／最後更新：2026-07-16
- 關聯：ADR-0029、Spec 001、`P2PEnvelope` v1

## 1. 目的與範圍

定義盲信使寄存報價、寄存欠條、第三方服務欠條交換與本人結清的 JSON 線上格式。定價函式、授信上限、欠條交換匯率與儲存淘汰方式由各信使自行決定；參考實作的本機耐久語義見 Spec 004。

本協議不定義 coin、全網餘額、鑄造、共識或法幣兌換，也不改變免費的成員間 anti-entropy。

## 2. 術語

- `issuer`：欠條發票人／債務人。
- `holder`：目前持有欠條、可要求履行的一方。
- `debtor`：取回自己寄存欠條並簽署結清的人，必須等於該欠條 issuer。
- `courier`：提供寄存並維護自己債權簿的信使。
- `contribution receipt`：服務者與受益人對實際服務量的共簽收據；受益人是 issuer，服務者是 holder。

所有 `nodeId` 必須是對應 ECDSA 公鑰 SPKI Base64 的既有 Nerilo 雜湊導出值；所有時間為 Unix epoch 毫秒，金額為有限且非負的 JSON number。

## 3. 共通信封與線上格式

所有訊息使用 `v: 1`、`ns: "courier"` 的 P2P JSON envelope。請求帶唯一 `id`；回覆以 `replyTo` 指向請求 `id`，並以 `to` 指向請求者。

### 3.1 身分與報價

計價前，成員必須先送 `type: "identify"`，payload 為 `{ "nodeId": string, "pubKey": string }`，並取得 `identify-ack` 的 `{ "ok": true }`。

`quote` payload：

```json
{ "bytes": 512 }
```

`quote-resp` 成功 payload：

```json
{
  "accepted": true,
  "quote": {
    "quoteId": "uuid",
    "courierNodeId": "node-c",
    "issuerNodeId": "node-a",
    "bytes": 512,
    "durationMs": 1209600000,
    "pricePerByteDay": 0.000001,
    "utilization": 0.42,
    "amount": 0.007168,
    "expiresAt": 1784160000000
  }
}
```

失敗為 `{ "accepted": false, "reason": "identity-required" | "pricing-disabled" | "invalid-request" }`。`bytes` 必須是正整數；報價必須綁定 requester、courier、bytes、期限與總額。是否調價及調價頻率不屬協議。

### 3.2 寄存欠條

`deposit` payload 在計價模式為：

```json
{
  "record": { "roomId": "r", "senderId": "s", "seq": 1, "timestamp": 1, "content": "ENC:...", "ttl": 3, "signature": "..." },
  "issuerPubKey": "base64-spki",
  "iou": {
    "iouId": "uuid",
    "quoteId": "uuid",
    "issuerNodeId": "node-a",
    "holderNodeId": "node-c",
    "amount": 0.007168,
    "issuedAt": 1784159900000,
    "nonce": "uuid",
    "issuerSig": "base64-signature"
  }
}
```

`deposit-ack` 成功至少含 `{ "accepted": true }`。拒收 reason 為 `identity-required`、`quote-required`、`quote-expired`、`quote-mismatch`、`invalid-iou`、`insufficient-credit`、`duplicate-iou`、`persistence-failed`，或既有 CourierStore 拒收原因。只有欠條驗證、store 寄存與已配置的耐久層都成功才可 ACK；任一失敗必須回滾紀錄與欠條。

### 3.3 服務欠條轉讓與本人結清

`repay` payload 是：

```json
{
  "debtorNodeId": "node-b",
  "debtorPubKey": "base64-spki-b",
  "depositIouIds": ["deposit-iou-1"],
  "transfer": {
    "receipt": {
      "relayNodeId": "node-b", "requesterNodeId": "node-a", "bytesRelayed": 8000,
      "ts": 1784159800000, "nonce": "service-1", "relaySig": "...", "requesterSig": "..."
    },
    "issuerPubKey": "base64-spki-a",
    "holderPubKey": "base64-spki-b",
    "toHolderNodeId": "node-c",
    "amount": 0.008,
    "transferNonce": "transfer-1",
    "issuerSig": "...",
    "holderSig": "..."
  },
  "settlementSig": "..."
}
```

成功 `repay-ack` 為 `{ "accepted": true, "settledAmount": number, "recipientSig": string }`。失敗 reason 為 `invalid-settlement`、`invalid-transfer`、`unknown-iou`、`amount-too-low`、`replayed-contribution` 或 `persistence-failed`。

## 4. 密碼學語義

簽章採 ECDSA P-256/SHA-256。實作先以 UTF-8 編碼下列 canonical JSON array，再取 SHA-256，最後對 digest 簽章；簽章與 SPKI 公鑰以 Base64 傳輸。

- 寄存 issuer 簽：`[iouId, quoteId, issuerNodeId, holderNodeId, amount, issuedAt, nonce]`
- 服務收據雙方簽：`[relayNodeId, requesterNodeId, bytesRelayed, ts, nonce]`
- 轉讓 issuer 與 holder 各簽：`[receipt.nonce, receipt.requesterNodeId, receipt.relayNodeId, toHolderNodeId, amount, transferNonce]`
- 本人結清簽：`[debtorNodeId, sort(depositIouIds), transfer.receipt.nonce, transfer.transferNonce, transfer.toHolderNodeId, transfer.amount]`
- 新 holder 接受轉讓時，對「轉讓 canonical array」簽出 `recipientSig`。

數字須以 ECMAScript `JSON.stringify` 的 number 表示法產生；不得使用 NaN、Infinity、字串金額或負數。任何 nodeId/公鑰綁定、欄位相等性或簽章驗證失敗都必須 fail-closed。

## 5. 狀態機與時序

1. `identify → identify-ack(ok)`。
2. `quote → quote-resp`；報價只可成功使用一次，過期或重放拒絕。
3. `deposit(record, iou) → deposit-ack`；成功後該信使持有 issuer 的寄存欠條。
4. 服務完成後，服務者與受益人先形成共簽 receipt。
5. receipt issuer 與現 holder 簽署轉讓；寄存欠條 issuer 對欲取回的欠條清單簽署 settlement。
6. 信使驗證全部條件、確認轉入面額不小於欲結清額，再簽 `recipientSig`；此狀態轉移必須原子地記錄轉入欠條並註銷指定寄存欠條。

網路逾時代表結果未知；相同 `iouId`、receipt nonce 或 transfer nonce 的重試不得造成重複債權或重複結清。

## 6. 錯誤處理與相容性

- 未知 envelope `type` 忽略；已知 payload 可忽略未知欄位，但所有必選欄位仍須驗證。
- 未知 envelope `v` 不得當作 v1 處理。任何簽章覆蓋欄位、canonical 形式或狀態轉移語義變更都必須升 major protocol version。
- 未啟用欠條簿的 legacy 信使可回 `pricing-disabled`，並可依原 courier v1 接受裸 `deposit`。啟用計價的信使對裸 deposit 必須回 `quote-required`。
- client 不得因信使拒收而刪除本地權威紀錄；可以改選其他信使，或完全不使用信使並等待免費成員 anti-entropy。

## 7. 安全考量

- 重放：報價單次使用；`iouId`、receipt nonce 去重；轉讓與結清綁定同一 receipt/transfer/holder。
- 冒名：所有參與簽章的 nodeId 必須綁定所附公鑰。
- 資源耗盡：信使以 per-issuer ε、儲存預算及本地擁擠價格拒收；本協議不解決低成本多身分，須由帳號／裝置信譽層補強。
- 報價操縱：調價頻率屬實作，但同一信使不得把單純請求次數直接當需求量；參考實作每個 pricing interval 最多調價一次。
- 中繼資料：信使可見 nodeId、roomId、bytes、時間、價格及債權關係，但不可解密 `ENC:` 內容。高匿名需求不在本協議保證內。

## 8. 經濟語義

每張欠條的價值由 issuer 信用與 holder 接受意願決定；不同 issuer 的相同數字不代表等值資產。協議不提供全域加總、兌價或強制接受。只有三方明示簽章才構成轉讓，只有原寄存 issuer 的 settlement 簽章才構成其本人欠條的結清。

## 9. 符合性判準

- [x] C1：報價綁定 requester/courier/bytes/amount；竄改任一欄位的寄存欠條拒收。
- [x] C2：同一 issuer 的未結總額超過本信使 ε 時拒收，其他 issuer 額度不受影響。
- [x] C3：轉讓缺 issuer、現 holder 或新 holder 任一同意時不得完成。
- [x] C4：結清簽章不是指定寄存欠條 issuer 所簽時不得註銷。
- [x] C5：同一服務 receipt 不得重複交換；store 拒收時不得留下寄存債權。
- [x] C6：信使拒收不影響成員本地紀錄與免費 anti-entropy 收斂。
- [x] C7：未知 envelope 版本不得當作 v1 執行。

## 10. 參考實作對照

- `src/core/incentive/CourierIOU.ts`：格式、canonical、驗章、債權簿與原子狀態轉移。
- `src/core/relay/CourierService.ts`：courier namespace 訊息與拒收語義。
- `src/core/relay/CongestionPricing.ts`：非規範性的本地定價參考。
- `tests/unit/CourierIOU.spec.ts`、`tests/unit/CourierService.spec.ts`：C1–C7 可執行證據。

已知邊界：參考債權簿已在同一瀏覽器以 IndexedDB 耐久化並於重載逐筆重驗；報價因短命且單次使用不保存。跨裝置備份、私鑰復原與多裝置合併未納入 v1。
