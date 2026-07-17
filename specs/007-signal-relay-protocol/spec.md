# Protocol Spec 007：加密 peer 中繼 signaling（nsig1）v0.1

- 軌別：protocol（跨實作互通層；變更視同公開 API 破壞性變更）
- 狀態：draft
- 建立：2026-07-16／最後更新：2026-07-16
- 關聯：Feature Spec 005（自主 p2p2p 連線）、ADR-0032（本協議取捨）、參考實作
  `src/core/p2p/SignalEnvelope.ts`（封拆）與 `src/core/p2p/SigRelayRouter.ts`（遞送）

> 協議軌的目標讀者是「用別的語言寫相容實作的人」。規格實作無關：以線上格式與
> 語義文字定義，TypeScript 型別僅是參考實作。

## 1. 目的與範圍

讓兩個尚未直連的節點（發起方 F、目標 T）經由雙方都已連上的**介紹人 X** 交換
WebRTC signaling（SDP offer/answer、ICE candidate），且 X 是**不可信管道**：
X 讀不到 signaling 內容（含 ICE 內的 IP 候選）、改任一位元組即被收端拒收。

範圍內：信封格式（§3）、密碼學語義（§4）、遞送與 ACK/NACK 語義（§5）。
實作自由（不規範）：介紹人選擇策略、退守傳輸（如 Firestore）、承載通道形狀
（本參考實作用 DataChannel 上的 JSON envelope，ns='sigrelay'）。

## 2. 術語

- **發起方（from）**：要送 signaling 的節點。
- **目標（to）**：應收到 signaling 的節點。
- **介紹人（introducer/relay）**：與 from、to 皆已直連、代為轉發密文的節點。
- **信封（envelope）**：一則加密 signaling 的線上單位（`nsig1`）。
- **wire**：承載通道上的訊息（信封本體或 ACK/NACK）。

## 3. 線上格式（wire format）

### 3.1 信封（nsig1）

```json
{
  "v": "nsig1",
  "from": "節點 id（字串，非空）",
  "to": "節點 id（字串，非空，不得等於 from）",
  "room": "房間 id（字串；介紹人路由/收端過濾用）",
  "kind": "offer | answer | ice",
  "epoch": 0,
  "ts": 1700000000000,
  "nonce": "逐信唯一字串（去重鍵 = from + nonce）",
  "ct": "Base64（AES-256-GCM 密文，見 §4）",
  "iv": "Base64（12 bytes）",
  "sig": "Base64（ECDSA P-256 / SHA-256，覆蓋 §4.1 canonical）"
}
```

全欄位必選。`epoch` 為收端 ECDH 金鑰世代（輪替向下相容用；現行實作恆 0）。
`ts` 毫秒時間戳，由發起方填入。明文 payload（加密前）為 UTF-8 字串：
offer/answer 為 `{"type":"offer|answer","sdp":"..."}`、ice 為
`{"candidate":"...","sdpMid":...,"sdpMLineIndex":...}` 的 JSON 序列化。

### 3.2 承載 wire（參考形狀；承載屬實作自由，但 ACK/NACK 語義見 §5）

```json
{ "kind": "env",  "env": { …nsig1… }, "hops": 0 }
{ "kind": "ack",  "ref": "<from>-<nonce>" }
{ "kind": "nack", "ref": "<from>-<nonce>", "reason": "字串" }
```

## 4. 密碼學語義

### 4.1 簽章（完整性＋來源）

- canonical 序列化＝**固定順序的 JSON 陣列**字串：
  `JSON.stringify([v, from, to, room, kind, epoch, ts, nonce, ct, iv])`。
- `sig` = ECDSA P-256（SHA-256）以 **from 的身分私鑰**簽 canonical 的 UTF-8 位元組。
- 簽章覆蓋密文與全部 metadata → 介紹人改 `ct`、換 `from`/`to`、動任何欄位皆令驗簽失敗。

### 4.2 加密（機密性）

- 共享密鑰：ECDH P-256（from 私鑰 × to 公鑰）→ 256-bit shared bits →
  HKDF-SHA-256（salt=`"nerilo-signal-relay-v1"`、info=`"signal-relay-encryption"`，
  皆 UTF-8）→ AES-256-GCM 金鑰。
- **域分離**：salt/info 為本協議專用，與其他用途（如群組金鑰分發）共用同一對
  ECDH 金鑰時導出不同 AES 金鑰。
- `ct` = AES-256-GCM(payload UTF-8, iv)；`iv` 每信封隨機 12 bytes。

### 4.3 收端驗證規則（fail-closed，順序固定）

1. `v !== "nsig1"` → 拒。
2. `to !==` 本機 id → 拒（轉錯對象）。
3. `from === to` → 拒。
4. 驗 `sig`（以 from 的身分公鑰，公鑰來源見 §7）失敗 → 拒。
5. ECDH 解密失敗（GCM 標籤不符）→ 拒。
任一步失敗：丟棄信封、**不得**建立連線、不得回傳解密錯誤細節給介紹人。

## 5. 狀態機與時序（遞送語義）

- 發起方：若 to 為直連鄰居 → 直送；否則逐一向直連鄰居送 `{kind:'env', hops:0}`
  請其中繼。等待 ACK；NACK 或逾時（參考值 2500ms）→ 換下一位；全滅 → 本協議
  無路（實作可退守其他傳輸）。
- 介紹人收到 `to ≠` 自己的信封：
  - `hops >= 1` → 回 NACK（hop 上限 1：不洪泛、無放大係數）。
  - to 是自己的直連鄰居且通道可用 → 轉發 `{hops: hops+1}`、回 ACK（hop-by-hop
    語義：ACK 表示「已轉上可用通道」，非端到端送達保證）。
  - 否則 → 回 NACK。
- 收端收到 `to ===` 自己的信封：回 ACK、依 §4.3 驗開。
- 去重：`from + nonce` 為信封唯一鍵；重複遞送（多路徑/重試）由收端以此去重。
- 回放：實作可短暫緩衝入站信封供晚掛載的收端補收（參考值 60s / 64 則）。

## 6. 錯誤處理與相容性

- 未知 `v`：拒收（本協議版本欄位嚴格）。
- 承載 wire 未知 `kind`：忽略（向前相容，允許未來新增 wire 種類）。
- 畸形 wire（缺欄位/型別錯）：靜默丟棄，不得使承載通道失效。
- 破壞性變更：bump `v`（`nsig2`…）；舊版共存期由實作決定，收端不識新版一律拒。

## 7. 安全考量

- **介紹人不可信**：機密性靠 §4.2（X 無 to 私鑰）、完整性靠 §4.1（改即失效）。
  X 可見的 metadata：from/to/room/kind/epoch/ts/nonce（見下）。
- **公鑰來源**：from 的身分公鑰與 to 的 ECDH 公鑰必須來自簽章名冊或頻外通道
  （如邀請連結內嵌）。名冊供應者若可換鑰即可 MITM——此風險屬名冊層，本協議
  假設公鑰綁定正確；參考實作以邀請連結內嵌公鑰提供頻外信任根。
- **重放**：同信封重放被 `from+nonce` 去重擋下；跨會話重放舊 offer 只會導向
  已失效的 ICE 交換（WebRTC 天然失敗），不造成連線劫持；`ts` 供實作加時效窗。
- **資源耗盡**：hop 上限 1 消除放大；介紹人只轉直連鄰居；per-peer 節流屬實作自由。
- **中繼資料洩漏（明確不處理）**：X 知道「from 想連 to、在哪個房」。隱藏社交
  圖譜（誰連誰）非本協議目標；需要時應疊加洋蔥路由（參考 SphinxPacket），
  本協議信封可作其內層 payload。

## 8. 經濟語義

無。signaling 握手量小（每 pair 數 KB），不計價；中繼貢獻計量若未來需要，
走 Protocol Spec 003 的收據原語，不改本格式。

## 9. 符合性判準（conformance）

參考測試向量產生器：`tests/unit/SignalEnvelope.spec.ts`（封拆）、
`tests/unit/PeerRelaySignalingTransport.spec.ts`（遞送）、
`tests/unit/SigRelayRouter.spec.ts`（ACK/NACK/hop）。

- [x] C1：封→拆往返：任意 UTF-8 payload 經 §4 封裝後，to 依 §4.3 還原逐位元一致。
- [x] C2：非 to 持有者（含介紹人）以其他 ECDH 私鑰解密必失敗。
- [x] C3：改 `ct` 或任一 metadata 欄位 → 驗簽失敗、拒收。
- [x] C4：以非 from 的金鑰簽章（冒名）→ 驗簽失敗、拒收。
- [x] C5：`to` 不符本機 → 拒收；`from === to` → 拒收。
- [x] C6：`hops>=1` 的信封不得再轉發（收到者回 NACK）。
- [x] C7：介紹人無 to 的直連通道 → NACK；發起方於 NACK/逾時後換介紹人或宣告無路。
- [x] C8：畸形 wire 不得使實作崩潰或使通道失效。
