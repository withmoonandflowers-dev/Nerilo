# Spec 015：把 Firestore signaling 開成可單獨取用的公開出口

- 軌別：feature
- 狀態：planned
- 建立：2026-07-25／最後更新：2026-07-25
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

`WarmSignalingDeps` 是新的公開型別，明列 warm 需要的四件事（本端 uid、身分金鑰來源、
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

- [ ] T1：定義 `WarmSignalingDeps` 公開型別，並把 `buildWarmColdFactory` 的內部組裝
      重構成可從外部注入的形狀（⚠ 動運作中路徑：mesh 現行 signaling 走同一條，先走 harden-tests）。
- [ ] T2：在 `src/sdk/firestore.ts` 加 `createFirestoreSignaling`（動態載入，維持入口隔離）。
- [ ] T3：加 `createWarmColdSignaling(deps)`，缺 mesh 相依時明示退化為 cold。
- [ ] T4：`sdkSurface` 測試納入新匯出；`prune-sdk-types --max=30` 確認不爆。
- [ ] T5：SDK-QUICKSTART 新章節 + rules／索引範本 + 誠實邊界三句。
- [ ] T6：block-brawl 端把 signaling 工廠換成 `createFirestoreSignaling`，跑跨設定檔對戰（V1）。

## 6. 驗收（黃金判準）

- [ ] V1 外部嵌入者實證：block-brawl 把 signaling 工廠從自製 BroadcastChannel 換成本 spec 的
      Firestore 出口後，**跨瀏覽器設定檔（不同 Firebase 匿名帳號）對戰可成立**，
      且 `connection.js` 零改動。不能用單元測試代替。
- [ ] V2 warm 的誠實性：對「無 mesh」的嵌入者，`createWarmColdSignaling` 的行為與
      `createFirestoreSignaling` 等價，且有測試釘住這個等價（避免文件說得比程式好聽）。
- [ ] V3 隔離閘門不退：`npm run qa:sdk-isolation` 續過——主入口 `nerilo` 仍不得靜態帶進 Firebase。
- [ ] V4 公開表面受控：`sdkSurface` 顯性納入新匯出；`prune-sdk-types --max=30` 不爆。
- [ ] V5 既有 mesh 零回歸：T1 重構後，mesh 既有 signaling 單元與 E2E 不紅（characterization-first）。
- [ ] V6 誠實邊界落地：文件三句到位並與 `docs/THREAT_MODEL.md` 一致，不得只寫好處。

## 7. 一致性自查（analyze，implement 前跑一次）

- [x] 第 4 節方案覆蓋第 1 節全部需求，無多做：需求＝讓第三方拿得到現成 signaling；
      方案＝兩個工廠 + rules／索引 + 誠實邊界。未順手做 SDP 簽章（第 2 節已明確排除）。
- [x] 第 5 節任務完整實現第 4 節，無遺漏：T1 對應 4.2 的 deps 收斂、T2/T3 對應兩個工廠、
      T5 對應 4.3 交付物、T4 是表面閘門、T6 是 V1 的執行面。
- [x] 第 6 節驗收能證明第 1 節：V1 用真實嵌入者跨設定檔對戰證明「拿得到且真的能用」；
      V2 專門擋「文件說得比程式好聽」這個本 spec 最可能的失敗模式（warm 被誤解成隨裝隨有）。
- [x] 未違反憲法任何一條：第 10 條（已知邊界自我揭露）由 V6 落地；第 4 條四不變量已於
      第 1 節逐條聲明；第 14 條本文件即為履行。
