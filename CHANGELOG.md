# Changelog

Nerilo 依語意化版號；`0.x` 期間 minor 版號可帶破壞性變更，每一項破壞都在此明示。

## 0.10.0（未發佈）

### 新增

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
