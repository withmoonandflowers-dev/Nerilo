# Spec 015：把 Firestore signaling 開成可單獨取用的公開出口

- 軌別：feature
- 狀態：blocked（T1-T5 完成；T6／V1 卡 Spec 014——第三方要用 signaling 得先有房，而匿名不能建房）
- 建立：2026-07-25／最後更新：2026-07-26
- 關聯：ADR-0025（可嵌入 SDK）、ADR-0032／Spec 005（p2p2p warm 中繼）、
  `src/core/p2p/SignalingTransport.ts`（`RoomSignalingTransport`／`RelaySignalingTransport`）、
  `src/core/p2p/WarmColdSignalingTransport.ts`、block-brawl `docs/nerilo-integration.md`（缺口 2）

## 1. 要做什麼、為什麼（specify）

SDK 目前的 signaling 是「全有或全無」：

- 想要 turnkey → `nerilo/firestore` 的 `createChatClient`，但那是**整個聊天客戶端**，
  signaling 藏在裡面拿不出來。
- 想要只用 signaling → 只能自己實作 `SignalingTransport`（契約有公開，這點是好的），
  但 Nerilo 已經寫好、已在 production 跑的 `RoomSignalingTransport`（Firestore）
  與 `WarmColdSignalingTransport`（warm 加密中繼）**沒有任何公開出口**。

後果，第一個外部嵌入者（block-brawl，2026-07-25）實測撞到：它照契約寫出了自己的
BroadcastChannel signaling，同機雙分頁可以打，但**要跨機器對戰就得自架後端**——
明明 Nerilo 有現成的、經過 production 驗證的一份。

這正好打在專案定位上：Nerilo 賣的是「私密 + 關不掉的通訊層」，而 signaling
是任何 P2P 應用的第一道門檻。把它開出去，嵌入者不必為了牽線自己蓋一套伺服器；
不開，「可嵌入」就只到 demo 為止。

**憲法檢核**（constitution.md）：
- 目標函數加分項：**可嵌入**（降低第三方採用的最大前置成本）、**隱私韌性**
  （若含 warm 中繼，第三方也能拿到「第三人零 Firestore 寫入」的性質）。
- 四條不變量影響：恰好一次〈無影響〉；**E2EE**〈需明說：signaling 傳的是 SDP／ICE，
  不是訊息內容；warm 路徑有信封加密、cold（Firestore）路徑的 SDP 對後端可見。
  這條邊界必須寫進文件，不能讓嵌入者誤以為 signaling 也是端到端加密的〉；
  帳本正當性〈無影響〉；**身分與授權**〈有影響：Firestore signaling 的完整性邊界目前是
  Firebase auth／rules（風險登記 R9、GOAL-ANALYSIS GS2 的 SDP 簽章仍未做）。
  開出去等於把這個邊界一併交給第三方，必須在文件與型別層講清楚〉。

## 2. 邊界（明確不做）

- 不做 SDP offer/answer 簽章（GS2）。那是獨立的安全工作，本 spec 只是把現況開出去，
  不假裝順手升級了完整性保證。
- 不把 `P2PConnectionManager`、`MultiP2PManager` 等內部連線類別列入公開表面。
- 不提供託管服務：嵌入者仍要自帶 Firebase 專案與 rules（本 spec 不做 BaaS，維持 ADR-0025 的 L2 定位）。
- 不改既有 mesh／chat 路徑的 signaling 行為。

## 3. 待釐清（clarify——2026-07-25 使用者拍板，決議內嵌於各題）

- [x] **Q1 開放範圍**：拍板 **warm + cold 一起開**。使用者選擇擴大範圍以取得「第三人零
      Firestore 寫入」這個賣點，接受公開表面隨之拉大。〔提案者原建議只開 cold；
      使用者拍板從寬，記錄於此，不再重議。〕
- [x] **Q2 出口形式**：拍板 **工廠函式**。內部類別（`RoomSignalingTransport`／
      `WarmColdSignalingTransport`／`PeerRelaySignalingTransport`）維持不穩定、可自由重構。
- [x] **Q3 出口位置**：`nerilo/firestore` subpath。沿用架構收斂 2026-07 的既有原則
      （主入口 `nerilo` 保持純契約、零 Firebase 型別），不另開第三個進入點。
- [x] **Q4 rules 與索引**：一併提供。沒有 rules 與索引，這個出口對嵌入者是不能跑的裝飾品。
- [x] **Q5 與 Spec 014 的關係**：拍板 **同一批出**，公開表面一次改完，只發生一次 minor 破壞。

## 4. 技術計畫（plan）

### 4.1 warm 的真實前提（設計約束，不是註腳）

實測 `MeshGossipManager.buildWarmColdFactory`（:347-412）：warm 不是一個可獨立安裝的傳輸，
它是**架在既有 mesh 鄰居 DataChannel 上的中繼**——`SigRelayRouter` 需要開著的鄰居
（啟用條件就是 `router.hasOpenNeighbors()`），另需身分金鑰（ECDH 私鑰 + 簽章）與
名冊型的對端公鑰解析。

推論（標推論）：對「沒有跑 Nerilo mesh 的嵌入者」（例如 block-brawl，自建
RTCPeerConnection、無 Nerilo 房間名冊），warm 沒有中繼底材可用，實際只會落在 cold。
因此本 spec 的兩個工廠**不是同一種東西**，文件必須分開講，不能並列成「兩個選項」：

- `createFirestoreSignaling()` — 任何嵌入者可用，零前提。
- `createWarmColdSignaling(deps)` — 只對「已經在跑 Nerilo mesh」的嵌入者有意義；
  缺 mesh 時退化為純 cold，且此退化必須是**明示的**（型別上要求傳入 mesh 相依，
  不讓人以為裝上去就有零伺服器中繼）。

### 4.2 出口設計（`nerilo/firestore`）

```
createFirestoreSignaling(): SignalingFactory
createWarmColdSignaling(deps: WarmSignalingDeps): SignalingFactory
```

〔實作期修訂〕型別最後拆成兩個：內部組裝吃 `WarmSignalingDeps`（`core/p2p/warmColdSignalingFactory.ts`），
公開表面吃 `WarmSignalingBackend`（`sdk/firestore.ts`，`epoch` 選填、無 coldFallback／clock）。
內外分家的理由：公開型別不該逼嵌入者認識 `coldFallback` 這種只有 mesh 內部會用的參數。

原計畫的單一型別明列 warm 需要的四件事（本端 uid、身分金鑰來源、
對端公鑰解析、鄰居就緒判定）。這四件事目前散在 `IdentityManager`／`SigRelayRouter`／
directory 裡，本 spec 把它們收斂成一個嵌入者看得懂的注入型別——這是本 spec 最大的
設計工作量，也是「表面拉大」的具體代價。

為何工廠而非類別：`WarmColdSignalingTransport` 的建構子有 5 個參數，其中 `patience`
是 Spec 005 T4 的介紹人耐心策略（純內部啟發式）。公開類別＝把這些細節升格成契約，
之後調 patience 就是破壞性變更。工廠讓內部繼續可調。

### 4.3 交付物

- `docs/SDK-QUICKSTART.md` 增一節「自帶 Firebase 的 signaling」：安裝、初始化、
  可複製的 `firestore.rules` 片段與所需索引、以及 4.1 的 warm 前提。
- 誠實邊界（憲法第 10 條）：signaling 傳的是 SDP／ICE 不是訊息內容；cold 路徑的
  SDP 對後端可見；SDP 未簽章（GS2 未做，風險登記 R9）。三句話都要在文件與型別註解裡。

## 5. 任務分解（tasks）

- [x] T1：定義 `WarmSignalingDeps` 型別，並把 `buildWarmColdFactory` 的內部組裝
      重構成可從外部注入的形狀（⚠ 動運作中路徑，已走 harden-tests）。**2026-07-26 完成。**

      落地位置：`src/core/p2p/warmColdSignalingFactory.ts`（型別 + 純組裝函式）。
      `MeshGossipManager.buildWarmColdFactory` 只剩「把 mesh 內部狀態翻譯成 deps」，
      金鑰檢查、router 建立、resolver、耐心策略都留在 manager（那些是 mesh 專屬狀態）。

      刻意只吃結構型別（`SignalRelayBus`／`PeerKeyResolver`／`LocalSignalIdentity`／`SignalClock`，
      皆為既有 exported interface），不吃 `SigRelayRouter` 具體類別——T3 要把這個型別
      放進公開表面，先綁死類別之後就拆不開。

      〔實作期發現〕這條路徑原本**零測試覆蓋**：`MeshGossipManager.spec.ts` 的
      IdentityManager mock 沒有 `getEcdhPrivateKey`，既有測試只走得到「無金鑰 → 退原
      factory」那一支，warm 組裝從未被任何測試碰過。先補了 10 條 characterization
      （`tests/unit/MeshWarmColdFactory.spec.ts`）釘住 C1-C7 現行行為，並以突變驗證
      （改耐心窗、反轉介紹人判斷）確認會紅 3 條，才動手重構。重構後該檔一字未改仍全綠。

      T1 驗證紀錄（2026-07-26）：type-check、lint（0 error／7 warnings 同基線）、
      全單元 138 檔 1554 tests、`qa:sdk-isolation`（MeshChatService 靜態圖仍 0 firebase）、
      `build:sdk`、React 護欄 E2E（golden-path + mesh-diagnostic 7/7）全綠。

      〔誠實記錄：一段未能解釋的 flake〕`mesh-diagnostic` 連跑時出現 1 過 2 敗 3 敗 4 過。
      當下的指令把輸出丟給 grep 過濾掉，**兩次失敗的實際訊息沒有留存**，無法事後歸因——
      這是操作疏失。補做對照實驗：未改動基線連跑 3 次 3/3 綠；重構後以**完全相同的 loop
      形狀**連跑 3 次亦 3/3 綠（另加 run4-6 共 6 次連綠）。兩者在同條件下無差異，
      故不將該 flake 歸因於本次重構；但也不宣稱已解釋它。附帶查明：
      `mesh-diagnostic.spec.ts` 沒有 `@stable` 標籤，不在 CI 硬閘子集內，
      所以 CI 全綠與這個 flake 並不矛盾——它是 harden-tests 要求的人工護欄，不是閘門。
- [x] T2：在 `src/sdk/firestore.ts` 加 `createFirestoreSignaling`（動態載入，維持入口隔離）。
      **2026-07-26 完成。**

      〔實作期發現：一個契約對撞〕`SignalingFactory` 要求**同步**回傳 transport，
      但動態 `import()` 是非同步的（不動態載就會讓 eager 進入點靜態帶進 firebase，
      `qa:sdk-isolation` 直接紅）。解法是新增 `core/p2p/lazySignalingTransport.ts`
      當接縫。最容易寫錯的一點已寫進該檔註解並補測試：`subscribe()` 必須當下回傳
      取消函式，而此時真 transport 還沒載完——取消函式得能取消「尚未成立的訂閱」，
      否則會留下拆不掉的 Firestore `onSnapshot`（持續計費 + 房間關了還投遞）。
      7 條單元覆蓋延遲、單次載入、載入前後取消、轉呼叫、載入失敗不炸呼叫端。

      適應度函數如預期咬人：`tests/unit/fitness.architecture.spec.ts` 的公開表面快照
      因新匯出而紅，依其設計「動它＝改公開契約，需顯性 review」——快照已顯性更新並附理由。
- [x] T3：加 `createWarmColdSignaling(deps)`，缺 mesh 相依時明示退化為 cold。**2026-07-26 完成。**

      「明示退化」的落實方式：省略 `warm` 時**直接回傳 cold 工廠本身**，不包任何看起來
      像 warm 的殼。這讓 V2 的等價可以用 identity 斷言（`toBe(cold)`）驗證，而不是
      靠讀文件相信。8 條單元覆蓋：無 warm 的兩種等價、有 warm 帶／不帶 remoteUid、
      epoch 預設 0 與顯式值、`hasWarmPath` 恆 false 仍可建。

      公開表面代價（spec §4.1 已預先記帳，此處結算）：除了 `createWarmColdSignaling`
      與 `WarmSignalingBackend`，還要一併公開實作者寫自己 relayBus／peerKeys 所需的
      `SignalRelayBus`／`PeerKeyResolver`／`SignalEnvelope`／`SignFn` 四個型別。
      `nerilo/firestore` 的匯出從 2 個變成 9 個。
- [x] T4：`sdkSurface` 測試納入新匯出；`prune-sdk-types --max=30` 確認不爆（`build:sdk` 通過）。
      適應度函數 `fitness.architecture.spec.ts` 的表面快照兩度如設計般擋下（T2 一次、T3 一次），
      皆顯性更新並附理由，未繞過。
- [x] T5：SDK-QUICKSTART 新章節「只要 signaling，不要整個聊天客戶端」，含可複製的
      rules 片段（依實際 `firestore.rules:198-219` 節錄）、`signals` 複合索引、TTL 建議、
      誠實邊界四點，以及 warm 的前提與退化說明。**2026-07-26 完成。**
- [~] T6：block-brawl 端把 signaling 工廠換成 `createFirestoreSignaling`，跑跨設定檔對戰（V1）。
      **2026-07-26 查證後判定：如原樣不可達成，範圍已調整並記錄理由。**

      **硬阻礙（實測 rules 原文，非推論）**：
      1. `firestore.rules:144` — 建房必須是**非匿名**帳號
         （`request.auth.token.firebase.sign_in_provider != "anonymous"`）。
      2. `firestore.rules:198-204` — 讀寫 `signals` 必須是該房 `participants` 或 `ownerUid`，
         rules 會 `get()` 父層房間文件。
      3. 合起來：任何第三方要用這個 signaling，**得先有一個 Nerilo 房間，且房主是註冊帳號**。
         匿名玩家可以「加入」既有房（`isAuthenticated()` 只檢查 `request.auth != null`），
         但不能開房。遊戲大廳的玩家全是匿名的，這條路走不通。

      **這正是 Spec 014 的缺口，而且它比原本評估的更嚴重**：014 不是「有了更好」，
      是 015 對非 Nerilo-app 嵌入者可用的**前置條件**。原本排序（先 015、014 等回饋）
      在此被實測推翻——回饋來了，結論是兩者相依。

      **已交付的可達成部分**：`tests/integration/sdk-signaling.spec.ts`，在 emulator 上
      以**真實 rules** 驗證出口本身可用：SDK 出口送出的 signal 被另一個 FirebaseApp／
      另一個帳號讀到；對端寫入的 signal 被 SDK 的 `subscribe` 收到；非參與者被 rules 擋下。
      3 例全綠。

      **它沒有證明什麼（不得引用為已完成）**：沒有證明跨實體裝置對戰、沒有證明
      block-brawl 能用（因為上述阻礙）、沒有碰 production Firestore。

      〔實作期教訓〕反向那條一度紅，`received` 收到的是前一支測試的 offer：
      admin SDK 刪除文件後，web SDK 的本地快取仍會在 `onSnapshot` 首次快照回放已刪文件。
      改成每支測試一間新房。差點誤判成產品 bug。

## 6. 驗收（黃金判準）

- [ ] V1 外部嵌入者實證：**未達成，卡 Spec 014**（見 T6）。原條件「block-brawl 跨設定檔對戰」
      在現行 rules 下不可能：匿名帳號不能建房，而 signals 需要房間 participants 身分。
      已交付的替代證據（`tests/integration/sdk-signaling.spec.ts`，真實 rules、emulator、3 例綠）
      只證明「出口本身可用」，**不等於** V1。V1 維持未打勾，等 014 落地後重跑。
- [x] V2 warm 的誠實性：**綠**。省略 `warm` 時直接回傳 cold 工廠本身，等價以
      `expect(createWarmColdSignaling({cold})).toBe(cold)` 的 identity 斷言驗證，
      並另有「完全不建 warm 傳輸」一條擋空殼（`WarmColdSignalingExport.spec.ts` 8 例）。
- [x] V3 隔離閘門不退：**綠**。`qa:sdk-isolation` 兩道皆過（MeshChatService 靜態圖 0 firebase、
      `dist/index.js` eager 進入點無 firebase 靜態 import）。
- [x] V4 公開表面受控：**綠**。表面快照兩度擋下並顯性更新；`build:sdk`（含
      `prune-sdk-types --max=30`）通過。
- [x] V5 既有 mesh 零回歸：**綠**。characterization 一字未改仍全綠；全單元 1570 tests；
      React 護欄 golden-path + mesh-diagnostic 7/7（另見 T1 的 flake 誠實記錄）。
- [x] V6 誠實邊界落地：**綠**。四點（非 E2EE／內容對後端可見／SDP 未簽章 R9／warm 需既有 mesh）
      同時寫在 `src/sdk/firestore.ts` 的 doc comment 與 SDK-QUICKSTART，並指回 THREAT_MODEL。

## 7. 一致性自查（analyze，implement 前跑一次）

- [x] 第 4 節方案覆蓋第 1 節全部需求，無多做：需求＝讓第三方拿得到現成 signaling；
      方案＝兩個工廠 + rules／索引 + 誠實邊界。未順手做 SDP 簽章（第 2 節已明確排除）。
- [x] 第 5 節任務完整實現第 4 節，無遺漏：T1 對應 4.2 的 deps 收斂、T2/T3 對應兩個工廠、
      T5 對應 4.3 交付物、T4 是表面閘門、T6 是 V1 的執行面。
- [x] 第 6 節驗收能證明第 1 節：V1 用真實嵌入者跨設定檔對戰證明「拿得到且真的能用」；
      V2 專門擋「文件說得比程式好聽」這個本 spec 最可能的失敗模式（warm 被誤解成隨裝隨有）。
- [x] 未違反憲法任何一條：第 10 條（已知邊界自我揭露）由 V6 落地；第 4 條四不變量已於
      第 1 節逐條聲明；第 14 條本文件即為履行。
