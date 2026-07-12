# ADR-0025：可嵌入 SDK（讓第三方串接 Nerilo 技術）

狀態：Accepted（P1 落地）
日期：2026-07-12

## 背景

要把 Nerilo 的 P2P mesh 聊天、E2EE、已讀人數、表情，變成「別人能串進自己系統來用」的
技術。盤點現況定級（L0 內部功能 → L1 乾淨內部架構 → L2 可嵌入 SDK → L3 託管 BaaS →
L4 開放協議）：目前在 **L1**。已有的底子是框架無關核心（`src/core|services|types` 零
React）、wire codec、恰好一次語義、port 雛形（`IChatStorage`/`IRoomService`）、以及
**已存在的 `SignalingTransport` 介面**（Firestore + Relay 兩實作）。

擋在 L2 前的兩道牆：
1. **Firebase 硬焊進傳輸/信令/認證層**（14 檔直接 import firebase）→ 第三方得整包吞
   Firebase 專案與 schema，不算「串接」。
2. **沒有 package 邊界**：無公開出口、無穩定門面、無版本化契約 → 是 App 不是 library。

形態選擇：**A 可嵌入 SDK**（第三方跑在自己 app、自帶後端）。捨 B 託管 BaaS（要多租戶/
計費/營運）與 C 開放協議（要規格治理），因 A 摩擦最低、最貼「讓別人運用這技術」、且最
契合補助/競賽的「開源韌性通訊」定位。

## 決策

分階段升 L2，前段共用：

- **P1（本 ADR）立門面 + 公開出口**：新增 `src/sdk`——`NeriloClient` 門面（收發訊息、
  表情、已讀人數、輸入中、生命週期）依賴 `IChatEngine` 契約而非具體後端；`src/sdk/index.ts`
  匯出穩定 API + 純 reducer + 注入用型別；預設工廠 `createFirestoreChatClient` 仍以既有
  Firestore 後端為底。純加法、不動運作中的 App。
- **P2 去 Firebase 化**（分兩半）：
  - **P2a（已落地）signaling 可注入**：把 `SignalingFactory`（`(roomId, channelLabel) =>
    SignalingTransport`）從 `MeshChatService` 一路串到 `MeshConnection` 建 `P2PManager`，
    省略即維持 Firestore（`P2PManager`/`P2PConnectionManager` 早已接受注入,故零行為變更,
    預設路徑由既有 mesh e2e 全綠背書）。附 `InMemorySignalingHub`/`InMemorySignalingTransport`
    參考實作（無 Firebase）+ 契約測試,證明這道縫真的可替換,也是自架 WebSocket 後端的形狀。
  - **P2b（已落地）discovery + auth 可注入**：把節點發現抽成 `IRoomDirectory` port
    （`registerIdentity`/`watchIdentities`/`getSnapshot`），`MeshTopologyManager` 與
    `MeshGossipManager` 改依賴它而非直接 `onSnapshot`/`RoomService`。auth 則直接把 uid
    從 `MeshChatService` 串下去（取代 `auth.currentUser`）。兩個 mesh 檔已無任何 firebase
    import。預設 `FirestoreRoomDirectory`（行為與重構前逐字一致,rejoin×4 + mesh e2e 全綠
    背書）；附 `InMemoryRoomDirectory` 零 Firebase 參考實作 + 契約測試。
  - **P3（部分落地）publishable 表面 + import 隔離**：
    - **已落地**：`src/sdk/index.ts` 這顆 barrel 的**靜態圖已無 firebase**（value import 只有
      NeriloClient〔純 reducer〕與 InMemory* 參考 adapter〔type-only import〕；Firestore 只在
      opt-in 的 `createFirestoreChatClient` 動態 import）。加了 `InMemoryChatStorage` 補齊可注入
      四件套（signaling / directory / auth-uid / storage）。`package.json` 補 `exports`（源碼層
      進入點）。加 sdkSurface 測試鎖住「只從 barrel import、全程無 firebase」的表面。
    - **未做（P3-final）turnkey firebase-free 引擎 + dist build**：`MeshChatService` 的**傳遞
      相依圖**仍有多處 firebase 觸點（P2PConnectionManager 的 `RoomSignalingTransport` 預設、
      HeartbeatService/GossipReplicaStore/RelayManager 等），非兩個預設可解，需整圖稽核 + 把
      預設 adapter 上移到 composition root（Vue 頁 + factory 注入）。另需 tsc/tsup 產 dist +
      `exports` 指向 dist 才是可 `npm publish` 的形。此步較大且動到 WebRTC 檔,獨立進行。
- **P3 契約 + 範例 + 打包**：`package.json` 的 `exports`/build（`@nerilo/sdk`）、版本化
  public types、第三方視角 quickstart 範例、integration 測試。

## 契約邊界

**穩定（列入 SDK 契約）**：`src/sdk` 匯出的 `NeriloClient`、`IChatEngine`、公開資料型別
（`ChatMessage`/`ReactionEvent`/`ReadEvent`…）、純 reducer（`applyRead`/`readCount`/
`applyReaction`/`orderKeyOf`/`encodeContent`…）、注入介面（`SignalingTransport`/
`IChatStorage`/`IRoomService`）。

**不穩定（不列入，可自由重構）**：`MeshChatService`/`MeshGossipManager`/`P2PManager` 等
內部類別、gossip wire 細節、crypto 內部。

## 後果

- 好處：第三方有穩定 API，內部可持續重構；`NeriloClient` 以假引擎即可單元測試（不需
  Firebase）→ 驗證抽象真的成立。門面把表情/已讀聚合封裝在純 reducer 後，第三方零心智
  負擔。
- 現階段限制（誠實）：P1 的預設後端仍需 Firebase 環境；「別人完全不吞 Firebase 即可用」
  要等 P2 的可注入後端。P1 交付的是**契約與門面**，不是後端替換。
