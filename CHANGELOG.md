# Changelog

Nerilo 依語意化版號；`0.x` 期間 minor 版號可帶破壞性變更，每一項破壞都在此明示。

## 0.12.0（未發佈）

### 新增

- 斷網會合（Spec 027）：①`nerilo-rendezvous` 本地會合點（`bin`，零依賴，區網內任一裝置
  可跑）＋`createHttpSignaling(baseUrl)` 工廠＋`createHttpRoomDirectory` 名冊——對外斷線但
  區網還在時可成房。會合點在 `/` 直接供應內建聊天頁（裝置瀏覽即用），並自動以 openssl
  產自簽憑證開 https（port+1）：WebCrypto 只在安全來源提供，http://<區網IP> 會死在
  身分產生，https 是其他裝置能用的硬需求（模擬實測抓到）；
  ②離線邀請碼 `createOfflineInvite`/`acceptOfflineInvite`（雙向雙 QR，酬載實測 ~630 bytes，
  deflate+base64url，`nqr1.` 前綴）——零基礎設施建立 `OfflineLink` 直連。
- `createChatClient` 補 `introducerUid` 透傳（Spec 005 warm 介紹人能力的工廠入口，
  與 identityNamespace 同型的既有疏漏）。

### 誠實邊界

- 本地會合點無認證（信任模型＝災難情境的區網）；OfflineLink 為 DTLS 傳輸加密、
  尚無房間金鑰 E2EE。相隔兩地且雙邊全斷仍不可用（需 LoRa 級異質傳輸，研究中）。

## 0.11.1（2026-08-26）

### 修正

- `createChatClient` 補上 `identityNamespace`（0.11.0 漏開）：同源多實例（同頁多 client、
  同機多視窗）的聊天嵌入者若不傳，會共用持久 mesh 身分 → mesh 把對方當自己、永不連線，
  且無錯誤訊息（症狀：狀態停在 connecting、訊息送得出去但沒人收得到）。
  transport 入口自 0.10.0 起就有此參數，聊天工廠當時漏了。花朝月夕OS 內建 app 實測抓到。

## 0.11.0（2026-08-26）

### 新增

- 檔案傳輸（Spec 026）：`NeriloTransportClient.sendFile`／`onFileOffer`——offer/accept
  同意制、16KB 分塊＋ack 視窗流控、進度事件、端到端 SHA-256 驗證、取消。上限 64MB，
  斷線＝失敗不續傳。通道 label `file` 成為保留字。實測 4MB 含加密 0.91s（4.4 MB/s）。
- `RawChannel` 語義修正：`close()` 改為先沖掉待送/待收再關（flush-then-close），
  入站解密序列化（修正 ordered 通道可能被非同步解密重排的潛在缺陷）。
- 房間共享狀態（Spec 025）：`NeriloTransportClient.sharedState()`——per-key LWW、
  晚進者連上自動補齊現況快照、刪除以墓碑防復活；全數走 raw 通道房金鑰密封管線。
  單 key 值上限 8KB、全狀態 64KB，超限拋錯不靜默截斷。通道 label `state` 成為保留字。
- SDK-QUICKSTART 改版為「按資料類型選通道」指南（六類資料 × 對應 API × 選錯症狀）。

### 破壞性變更（0.x 瘦身，2026-08-24 API 體檢定案）

- 移除 `createFirestoreChatClient`（`nerilo/firestore`）：純別名，改用同參數的
  `createChatClient`。
- 主入口移除 `IRoomService` 型別匯出：SDK 沒有任何注入縫使用它（孤兒型別）；
  房間列表需求請用 `IRoomCatalog`。
- 主入口移除 `encodeContent`／`decodeContent`：門面的 `sendMessage`／`decode`
  已涵蓋，裸函式零外部使用情境。

### 已知邊界

- LWW 語義：高頻並發改同一 key 會互蓋；狀態不持久化（全員離開即消失）；
  晚進者拿到現況、看不到歷史過程（與前向保密設計一致）。

## 0.10.0（2026-08-24）

### 新增

- `identityNamespace` 注入縫（IdentityManager／MeshGossipManager／createTransportClient）：
  同源多實例嵌入（同機雙分頁）時各實例可有獨立持久 mesh 身分。省略＝既有行為。
  未傳時同源多實例會共用身分導致 mesh 永不連線（block-brawl 實測發現）。
- 房間目錄契約（Spec 014）：`IRoomCatalog`／`CatalogRoom`（list／watch／publish／
  unpublish 四動作），主入口附 `InMemoryRoomCatalog(+Hub)` 參考實作；
  `nerilo/firestore` 加 `createFirestoreRoomCatalog`（包既有公開房列表與建房/關房，
  watch 為輪詢）。注意：Firestore 版建房要求非匿名帳號（rules 既有語義，未放寬）。
- 遊戲/低延遲傳輸入口 `nerilo/transport`（Spec 023）：`createTransportClient` 建立
  不含訊息層的 mesh 傳輸客戶端；`openRawChannel`／`onRawChannel` 在 peer 間開
  raw DataChannel（參數直通 WebRTC），資料以房間金鑰 AES-GCM 密封（raw-v1 格式）。
  金鑰未就緒＝丟棄＋計數（`dropped()`／`droppedInbound()`），無恰好一次保證。
- 連線與加密狀態 API（Spec 024）：`NeriloClient.status`（同步快照）與
  `NeriloClient.onStatus(cb)`（變更訂閱，訂閱當下先收一次、同值不重發）。
  型別 `NeriloStatus`／`NeriloTransportState`／`NeriloEncryptionState` 自主入口匯出。
- examples/minimal-chat 加狀態列，示範「連線中 → P2P 直連 → 加密就緒」的真實轉換。

### 破壞性變更

- `IChatEngine` 新增必要方法 `getStatus()` 與 `onStatus(listener)`。
  自帶引擎的實作者必須補這兩個方法（照 InMemory 引擎的最小實作即可：
  快照回固定值、onStatus 訂閱當下發一次）。只消費 `NeriloClient` 或
  `createChatClient` 的使用者不受影響。

## 0.9.0（2026-08-24）

- npm 首發。可嵌入 SDK：`NeriloClient` 門面、四道注入縫（signaling／directory／
  storage／身分）、InMemory 參考實作、純 reducer、`nerilo/firestore` turnkey 工廠。
