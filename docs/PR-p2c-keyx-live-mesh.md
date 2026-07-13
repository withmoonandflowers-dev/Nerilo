# feature/p2c-keyx-live-mesh

把 Nerilo 從「一個 App」推進到「別人可串接的可嵌入 SDK」，中間補齊盲信使中繼、聊天與遊戲功能，並修掉數個 mesh 可靠性根因。相對 origin/master：67 commits、180 檔、+31.5k/-1.1k。

分支跨了多個主題，若 review 負擔太大可依下列分節拆成多個 PR。以下按主題整理，非按 commit 順序。

## 1. 可嵌入 SDK 化（本階段主線，L1 App → L2 可嵌入 SDK）

目標：第三方帶自己的後端就能 `import 'nerilo'` 串接，全程不碰 Firebase。

- **公開契約與門面**（`src/sdk/`）：`NeriloClient` 門面依賴 `IChatEngine` 契約而非具體後端；`src/sdk/index.ts` 定穩定表面（門面 + 純 reducer + 注入型別），內部 mesh/gossip/crypto 類別不列入、可自由重構。
- **四道後端縫全可注入**：
  - signaling：`SignalingFactory` 串到 `MeshConnection` 建 `P2PManager`（`P2PManager`/`P2PConnectionManager` 早已接受注入）。
  - discovery：節點發現抽成 `IRoomDirectory`（`registerIdentity`/`watchIdentities`/`getSnapshot`），`MeshTopologyManager`/`MeshGossipManager` 改依賴它。
  - auth：uid 從 `MeshChatService` 串下去，取代 `MeshGossipManager` 的 `auth.currentUser`。
  - storage：既有 `IChatStorage` port，新增 `InMemoryChatStorage`。
  - 每道縫都附零 Firebase 記憶體參考實作（`InMemorySignalingTransport`/`InMemoryRoomDirectory`/`InMemoryChatStorage`）+ 契約測試。
- **import 隔離**：預設 Firestore adapter 從建構期靜態 import 改為 `initialize()` 內動態 `import()`（未注入才載）；`P2PConnectionManager` 直用的 firestore `Timestamp` 換毫秒 number，型別轉換下放 `RoomSignalingTransport.send`。結果：`MeshChatService` 整條靜態 import 圖的 firebase 檔數 5 → 0（trace 驗證）。參數維持選填，零呼叫端/測試/composition-root 更動。
- **turnkey 工廠**：`createChatClient({ signaling, directory, storage })`，全注入時建構路徑不含 Firebase。
- **dist build**：`npm run build:sdk` = esbuild（`--bundle --splitting --format=esm --packages=external`）+ tsc（`.d.ts`）。`--splitting` 把 Firestore/預設 adapter 切進動態 chunk，`dist/index.js`（eager 進入點）零 firebase 靜態 import。`package.json` 的 `main`/`module`/`types`/`exports`/`files` 指向 dist，`prepublishOnly` 自動 build，dist 進 .gitignore。
- **實測**：純 Node（無 Vite、無 Firebase）`import('./dist/index.js')` 成功，16 個 export 全可用，`InMemoryChatStorage` 可跑；`createChatClient` 注入全記憶體後端可在 node 建出完整引擎。

文件：`docs/SDK-QUICKSTART.md`、`docs/adr/0025-embeddable-sdk.md`。

## 2. 聊天與遊戲功能

- **五子棋**：15x15 連 5，與井字棋共用同一條 mesh game 通道（`MeshGameBus`）。
- **訊息 reactions**：走 mesh `reaction` 通道，純 reducer 聚合（冪等、亂序收斂），與聊天同 E2EE 管線。
- **訊息回覆**：`replyTo` 嵌入密文內容，引用預覽雙向 E2E 通。
- **已讀人數**：per-member 水位模型（`readReceipts.ts` 純 reducer，單調取 max），走 mesh `read` 通道；只在自己訊息顯示，3+ 人房「已讀 N」、2 人房「已讀」。順帶修一個跨端 orderKey 分歧的正確性坑（寄件端本機回音與線上複本共用同一 timestamp）。
- **3-5 人遊戲房**：入座/離座座位模型，2 人對戰、其餘觀戰。

## 3. 盲信使中繼（P4，離線送達）

- P4-A 名冊地基：`FirestoreRelayDirectory` + 跨房節點 presence 發現。
- P4-B 陌生節點連線：站級 signaling（`relaySignals`）+ `RelayConnector` 串起 relay-only 連線，補齊 DataChannel。
- P4-C 盲信使寄存：`CourierStore`/`CourierService`、anti-entropy 自動對帳、房籍簽章墓碑、IndexedDB 持久化（跨 reload 存活）。
- P4-D 計量：共簽收據 → 點數，信使賺可驗點。

## 4. mesh 可靠性根因修復

- **reserveSeq 掉訊**：Dexie PrematureCommitError/InvalidStateError → 記憶體 seq fallback 碰撞 → 掉訊。改用記憶體計數器為本會話真相 + best-effort 非阻塞持久化。
- **離開再進房卡連線中**：對方持久身分 userId 不變，stayer 留著死 pc、對方新 offer 無處接。改由 `joinedAt` 偵測 rejoin，stayer 拆舊建新 pc；`getState` 以 DataChannel open 為連上真相。
- **rejoin 最壞延遲**：rejoin 首次重建改用 15s 較短 ready 逾時（首連/退避重試維持 30s），最壞 ~46s → ~12s 中位。
- **座位模型掉訊**：2 人房不送 seat gossip，避免與聊天搶 sender seq。

## 5. star 退役（P2-③）

2 人房一律切 mesh gossip 複寫日誌，star 直連路徑退役；mesh 房 Firestore 備援改房間金鑰密文（不再明文洩漏）。

## 架構決策

ADR-0023 多次修訂（P2-③ star 退役、P4 盲信使）、ADR-0024（盲信使寄存）、ADR-0025（可嵌入 SDK）。

## 測試與驗證

- Unit 1369（含 readReceipts/reactions/neriloClient/inMemorySignaling/inMemoryRoomDirectory/sdkSurface 等新測），type-check、lint 0 error。
- E2E（Firebase emulator）：golden-path、mesh-e2ee、game-rejoin（房主/非房主 x4 重跑）、rejoin、read-receipts、game-seats、gomoku、reactions、reply、game-theme 全綠。
- 每個高風險改動（reserveSeq、rejoin、SDK import 隔離）都以 e2e 回歸背書，預設 Firestore 路徑行為保真。
- 補測試工具鏈：確定性模擬 + Stryker mutation（RecordCrypto 61.70 → 80.85%）。

## 相容性與風險

- SDK 改動全部維持參數選填、預設走 Firestore，App（React/Vue）行為不變。
- 動到 WebRTC 連線層（`P2PConnectionManager` signaling 抽象、Timestamp→number、async setup）與 mesh 發現層，皆有重 e2e 覆蓋，回歸全綠。
- React 版仍凍結；production 為 Vue（`web-vue/`）。

## 發佈備註

SDK 套件名 `nerilo`，`npm run build:sdk` 產 dist 後可 `npm publish`。發佈需 npm 帳號授權（未在此 PR 內執行）。
