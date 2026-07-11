# ADR-0023：資料中心化傳訊——房間即複寫日誌，連線只是傳輸機會

- 狀態：Proposed（2026-07-06 產品負責人提出方向，待拍板）
- 承接：ADR-0009（Nerilo 是資料傳遞架構）、mesh 可靠性第三輪（QA-REPORT-chat 第三輪）、
  持久聊天室產品模型（f3b733e）

## Context：兩個世界觀的衝突

「離開聊天室再進去就收不到訊息」bug 的兩輪修復嘗試（Vue 層看門狗、
perfect negotiation）都失敗且一度弄壞首次連線。復盤發現失敗不是手藝問題，
是**世界觀問題**：

- **連線中心（現況 star）**：訊息的存在依附於「那一條」P2P 連線。連線死了
  訊息就丟了，重連要在 WebRTC signaling 的四層時序（頁面生命週期 ×
  DataChannel × signaling 狀態機 × Firestore session 對齊）裡搶救——每一層
  都可能對不上，這正是兩次失敗的原因。
- **資料中心（mesh 已驗證）**：訊息是「簽章的不可變紀錄」，身分是
  (senderId, seq)。每位成員持有複本，週期性 anti-entropy 對帳，缺哪則
  任一在線成員補哪則。連線只是「傳輸機會」，斷線是傳輸層的正常事件。
  這條線已用 3 人診斷 E2E 連續多批「矩陣全 =1」證明收斂。

產品負責人 2026-07-06 定調：**雙方的連線只是雙方已溝通（加密訊息），實際上
是多個參與者共同紀錄資訊；一人斷線重連後，其他人把資料補足；每個人都幫
別人暫存資料**——即資料中心世界觀升級為全站架構。

## Decision（提案）

### 三條互相解耦的生命週期

1. **房間複本（Room Replica）**——每成員一份，落地 IndexedDB。
   `cold →(進房載入) syncing →(對帳補齊) live ⇄(離頁/重進) detached → archived(退出/刪除)`
   生命週期綁「成員關係」（在籍即存在），不綁頁面 instance。
2. **Peer 傳輸 session**——每對成員之間，用完即棄。
   `discovered → connected(gossip+digest) → gone(斷線=正常事件)`
   斷線不修屍體：對方回來就建全新 session。斷線事件**不外溢**到另外兩條生命週期。
3. **訊息紀錄（Message Record）**——加密後簽章的不可變紀錄。
   `created(加密→簽章) → persisted(本地) → replicating(gossip+對帳) → converged(全員恰好一次) → evicted(超量淘汰, floor 語義)`

### 核心不變量

> 只要任一位「持有該紀錄的成員」在線，其他成員終能補齊到 converged。
> 連線的死活只影響「多快」，不影響「會不會」。

### 關鍵技術決定

- **紀錄身分 (senderId, seq)，seq 持久化**：現況 `GossipMessageHandler.seq`
  是記憶體變數（重進/重載歸零 → 與對方 store 舊 seq 碰撞 → 新訊息被當重複
  靜默丟棄）。改為 per (roomId, identity) 的 IndexedDB 持久單調計數。
  這同時修掉「跨會話重放」已知殘留（seq 不重用 + floor）。
- **store（複本）落地 IndexedDB**：現況 mesh store 在記憶體。落地後即使
  只剩一人在線也能補齊他人，重載自己也不丟。
- **E2EE 先於統一**：紀錄格式從第一天就是「密文 + 簽章」。幫別人暫存 ≠
  能讀（暫存者只見密文）。金鑰交換（既有 SenderKeyManager/ECDH）騎同一
  傳輸。避免先統一明文再遷移紀錄格式的二次工。
- **2 人房走同一條管線**：star 特例退役（或降級為純傳輸優化）。
  「離開再進」bug 因此**整類消滅**——重進 = cold→syncing→live，
  缺的訊息由留房者補，無需連線復活術。
- **暫存即貢獻**：為他人保存/補送紀錄計入中繼貢獻 → 點數（接 ADR-0020/0021
  既有 CreditEconomy）。「每個人都會幫別人暫存資料」與點數經濟同構。

### 誠實邊界（不解決什麼）

- **全員離線時無人可補**：peer 互補的前提是至少一人在線。雙方都離線期間
  的離線投遞，仍靠 Firestore 加密備援（現有）或未來房外中繼暫存（Phase 4，
  休眠的 store-and-forward/relay 模組 + Sphinx）。
- **E2EE × 補齊的張力**：forward secrecy 的金鑰輪替 vs 遲入者補歷史。
  取捨：成員只能補齊「自己在籍期間、持有對應 epoch 金鑰」的紀錄——
  這同時是隱私特性（新成員看不到加入前的歷史），非缺陷。
- **保留策略**：每 sender cap + floor（既有語義）；複本上限與淘汰協調
  屬 Phase 3。

## 落地階段（每階段有硬驗證標準）

| 階段 | 內容 | 驗證標準 |
|---|---|---|
| **P1 基座** | seq 持久化 + store 落地 IndexedDB + session epoch 語義 | 單元：重載/重建 handler 後 seq 續增不碰撞；3 人 E2E：成員 cleanup→重建後訊息互通、矩陣全 =1 |
| **P2 統一** | 紀錄格式（密文+簽章）+ 2 人房切 gossip 管線、star 退役 | `rejoin.spec` 由 fixme 轉綠（本 bug 的定義性驗證）；黃金路徑/遊戲/好友全綠；DM 維持 E2EE |
| **P3 韌性** | detached 降頻/資源策略（多常駐房）+ 真斷線快速重建 + 保留策略 | 斷網→恢復 E2E；N 房並存資源上限 |
| **P4 網絡** | 房外中繼暫存（喚醒 relay/store-and-forward 休眠模組）+ 暫存計點 | 雙方離線經第三節點補齊的整合驗證 |

## Consequences

- 「重連工程」從最難的 signaling 層（兩次失敗）移到資料層（已驗證），
  perfect negotiation 降級為 P3 的範圍縮小版（只服務真斷線加速，不再背負
  「重進必須靠它」）。
- 韌性敘事（補助/競賽定位「隱私+韌性通訊」）獲得可演示的技術實體：
  「斷線不掉話——因為房間是全員共同保存的加密日誌」。
- 成本：複本儲存與對帳流量隨房數成長，需 P3 資源策略；star 的低延遲
  直連優勢由「gossip 管線在 2 人時退化為單邊直送」自然保留。

---

## 修訂二（2026-07-06）：盲信使正式化 + 全員斷線重生驗收

產品負責人補充兩項需求，納入本 ADR：

### R1. 盲信使（非成員盲存）——P4 的正式主體

願景：C 未加入房間、只開著首頁，也為 A/B 的房間保存**加密複本**並參與補齊；
C 讀不到內容（無房間金鑰）、改不了紀錄（簽章）。全員可為彼此暫存。

- **協議天然相容**：anti-entropy 只比對 (senderId, seq)，不讀內容——密文紀錄
  照樣可 digest/補送，簽章隨紀錄走、收端自驗。盲存不需要新協議，只需要密文。
- **硬依賴：P2 紀錄密文化**。紀錄仍為明文前，任何「給非成員存」= 洩露。
  因此 P2 的優先級由此需求確立。
- **缺件**：①全站 overlay（relayDirectory 名冊 + 陌生節點 DataChannel，
  設計見 docs/design/site-wide-relay-overlay.md）；②盲信使協議（寄存/對帳/
  多副本/儲存上限與淘汰）；③計量與激勵（共簽收據 → 點數；PeerScoring 防擺爛）。
- **威脅模型**：C 盲但不可信——可丟包/擺爛（多副本+激勵處理）；可見 metadata
  （roomId/量/時間；以既有 padding/cover traffic 緩解，列 P5 後）。
- **驗收（到時）**：A/B 房間、C 在首頁；A 離線期間 B 發訊；B 也離線、
  C 仍在線；A 回線後「僅經 C」補齊（Firestore 備援停用之測試模式下）。

### R2. 全員斷線後重生——已達成，列為 P1 驗收擴充

需求：全員下線（零在線複本）後，成員回來要能 ①從本地複本立即呈現歷史
（不等連線）、②房間連線自動重建、③繼續收發。

**已由 P1 覆蓋並驗證**：`tests/e2e-vue/all-offline-revival.spec.ts`（3 連綠）——
三人建立歷史 → 全員下線 → A 獨自回線時歷史即渲染（local-first，房內零在線者）
→ B/C 回線後連線重建、歷史各恰好一次、新訊息雙向互通（seq 續增）。
架構原因：房間沒有任何「中央 session」可過期；Firestore 房檔永續（metadata），
內容複本在各成員本地。

### R2 相關的已知缺口（誠實記錄）

- **star（2 人）房單獨在線發訊**：對方離線時 E2EE 備援需金鑰已建立；
  首次未完成金鑰交換前無法離線寄送。隨 P2 統一管線 + P4 盲信使解。
- **完全離線開啟（無網路渲染）**：需 Firestore offline cache + PWA，
  獨立工程，非本 ADR 範圍（列未來項）。

---

## 修訂三（2026-07-06）：P2 密文化的金鑰分發設計（接線前定案）

P2 把紀錄內容密文化。加解密原語已落地並測試（`RecordCrypto`，單一密文信封、
簽章覆蓋密文、盲信使可存可驗不可解）。接線前必須先定「房間內容金鑰怎麼分發、
怎麼與複寫日誌共存」——這是分散式設計，不可邊寫邊猜。

### 決策：內容金鑰本身也是日誌紀錄（key-as-record）

- 房間內容金鑰由 `GroupKeyManager`（sender-key 策略，已測試）產生。
- **分發載體 = 複寫日誌自己**：金鑰分發訊息（每成員一份 ECDH 加密的內容金鑰）
  以特殊 channel（`channel:'keyx'`）的紀錄寫入 gossip 管線。於是：
  - 遲入/重進成員靠既有對帳補齊 keyx 紀錄 → 重導內容金鑰 → 解得開歷史密文。
  - 盲信使照樣保存 keyx 紀錄（它也是密文，信使解不開）→ 全員斷線後成員回來，
    金鑰與內容一起從複本/信使補齊。**金鑰韌性 = 資料韌性，同一套機制。**
- epoch：金鑰輪替（加人/移除/週期）遞增 epoch，新 keyx 紀錄廣播；`RecordCrypto`
  信封帶 ep，解密端選對應 epoch 金鑰。

### 前向保密 × 補歷史的取捨（沿用 R2 原則）

成員只能解「自己在籍期間、持有對應 epoch 金鑰」的紀錄。加入前的歷史密文
即使補到本地也解不開——這是隱私特性（新成員看不到入群前對話），非缺陷。

### P2 分階段（降低對運作中路徑的風險）

| 階段 | 內容 | 風險 | 狀態 |
|---|---|---|---|
| **P2-①** | `RecordCrypto` 加解密原語 + 單元 | 零（純函數、無接線） | ✅ 完成 |
| **P2-②** | keyx 分發紀錄接進 gossip 管線 + GossipMessageHandler 收送時加解密（mesh 房，內容金鑰就緒才啟用；未就緒退明文相容） | 中（動 mesh 收送路徑，有 mesh-diagnostic/rejoin E2E 護欄） | 🎯 next |
| **P2-③** | 2 人房切 gossip 管線、star 退役；typing/遊戲/備援跟隨 | 高（改唯一穩定的 2 人路徑）→ 專注階段 | ✅ 完成（見修訂五） |

star 退役（P2-③）與密文化（P2-①②）解耦：即使 P2-③ 延後，盲信使（P4）
只需 mesh 房密文化（P2-②）即可先行驗證於 3-5 人房。

---

## 修訂四（2026-07-06）：P2-②c keyx 接進 live mesh（接線決策）

把 keyx 分發接進 live mesh（`MeshGossipManager`／`GossipMessageHandler`／新增
`RoomKeyCoordinator`），讓 3-5 人 mesh 房真正端到端加密。以下決策在接線時定案。

### 決策 1：ECDH 公鑰走 `meshIdentities`（擴充欄位），非另發 gossip announce

每成員的 ECDH 公鑰是「靜態身分」（如同既有 ECDSA 簽章公鑰），故加一個
`meshIdentities[uid].ecdhPubKey` 欄位隨身分一起發布，而非用一筆 gossip 紀錄廣播。
- **低風險**：沿用既有身分註冊路徑（`RoomService.updateMeshIdentity`），不新增 gossip 通道語義。
- **MITM 防護沿用**：`firestore.rules` 的 `meshIdentitiesChangeIsValid`
  （`affectedKeys ⊆ {auth.uid}`）本就擋下覆寫他人條目；另補 `ecdhPubKey` 格式驗證（可選、有才驗）。
- ECDH 金鑰對持久化於 IndexedDB（`IdentityManager`，與 ECDSA 身分同 blob、獨立金鑰對）——
  全員斷線重生後舊 keyx（封給舊 ECDH 公鑰）仍開得了，符合「金鑰韌性 = 資料韌性」。
  持久失敗（Safari 隱私模式/node）退 session 內暫時金鑰（該裝置重啟後無法解舊 epoch，已記錄取捨）。

對比「一筆 gossip announce 廣播 ECDH 公鑰」：雖與 key-as-record 更一致，但需新通道 + 收端信任處理，
風險高於擴充靜態身分欄位；且 keyx 紀錄本身已走 gossip（下述），靜態公鑰無需再走一次。

### 決策 2：keyx 紀錄走 gossip；產生方＝完整穩定名冊的最小 userId（三道閘門）

內容金鑰產生方用 `RoomKeyDistribution.sealRoomKeyForAll` 封給所有在場成員，以
`channel:'keyx'` 寫進 gossip 管線（與一般訊息同一條對帳，遲入/重進靠 anti-entropy 補齊）。
產生方 deterministic 選舉＝在場成員 userId 字典序最小者。

**接線中發現並修復的關鍵 bug（雙產生方 epoch 碰撞）**：形成期若以殘缺名冊搶先分發，
兩個「各自視圖的最小者」會各發一把 epoch-0 金鑰（不同鑰、同 epoch）→ 金鑰環相互覆蓋
→ 收端解密失敗。修法為 `RoomKeyCoordinator` 三道分發閘門：
①全員 ecdh 就緒（eligible == participants）②名冊連續穩定數輪 ③我是完整名冊最小者。
令「只有最終完整名冊的最小者」分發。殘留（Firestore 傳播 > 穩定窗的持久分裂視圖）極不可能且
會在收斂後以 `getMaxKnownEpoch()+1` 自癒（新一輪 epoch 遞增，不再同號）。

### 決策 3：消費在 `GossipMessageHandler`；金鑰環按信封 epoch 選鑰

收到 `channel:'keyx'` 且 `forMember == 自己` → `openSealedRoomKey` → `setContentKey(key, epoch)`；
keyx 不進聊天顯示（如同 game 通道分流），但照樣入 store／轉發／對帳（盲信使/遲入者補齊）。
內容金鑰改為 **epoch → key 金鑰環**：送出用最高 epoch，解密按各密文信封 epoch 選鑰
（加人/移除輪替後仍能解舊 epoch 歷史密文）。全程「無鑰退明文相容」不變——沒拿到 keyx 前 mesh 房照舊明文。

### 決策 4：keyx 名冊＝`meshIdentities ∩ participants`（移除成員前向保密的前提）

接續時發現：`RoomService.leaveRoom` 只縮 `participants`、**不清 `meshIdentities`**（離開者條目殘留）。
若產生方直接用 `meshIdentities` 當名冊，離開者會（a）續留名冊使 sig 不變 → 不觸發重發、
（b）被續封鑰 → **無前向保密**。故 `rosterFromRoom` 只認「仍在 `participants` 的成員」：
離開即退出名冊 → 名冊縮小 → 新 epoch 新金鑰只封給留下者 → 離開者持舊 epoch 鑰、解不了新 epoch。
以確定性整合測（`tests/unit/MeshKeyxIntegration.spec.ts`）驗證加人/移除兩向的 epoch 輪替與前向保密。

### P2 分階段狀態更新

| 階段 | 狀態 |
|---|---|
| P2-②a `GossipMessageHandler` 收送加解密接線（金鑰為閘、無鑰退明文） | ✅ 完成 |
| P2-②b `RoomKeyDistribution` 成對封裝協議（純函數） | ✅ 完成 |
| **P2-②c keyx 接進 live mesh（本修訂）** | ✅ 完成（3 人 mesh E2E：UI 明文、複本密文；mesh-diagnostic 未迴歸） |
| P2-③ 2 人房切 gossip、star 退役 | ✅ 完成（見修訂五） |

---

## 修訂五（2026-07-07）：P2-③ 2 人房切 mesh、star 退役（Vue 版）

Vue 版（web-vue，ADR-0017 重寫；React 生產版凍結、仍星型）2 人房從此走
gossip 複寫日誌，star 特例邏輯退役（`decideTopology` 一律回 mesh）。分三階段
（characterization-first，每階段逐層閘門 + 連跑確認非 flaky）：

- **Phase 1 — mesh typing**：typing 是暫態信號，走 `MeshConnection` 新增的
  `ns:'presence'` lossy 通道（不進 gossip 可靠日誌/對帳，仿 `relay:forward` 分流）。
  `MeshGossipManager.broadcastTyping/onTyping`，Vue chat page 依拓撲分流 `emitTyping`。
- **Phase 2 — mesh 遊戲**：`useTicTacToe`/`TicTacToePanel` 的 bus 型別由具象
  `P2PChannelBus` 放寬為最小 `GameBus` 介面（星型結構相容、零回退）；
  `MeshChatService.sendGameEnvelope/onGameMessage` 走 M4 `channel:'game'` 可靠管線；
  `MeshGameBus`（web-vue）轉接。回合制事件走可靠管線比星型 lossy bus 更穩。
- **Phase 3 — 切換 + rejoin**：chat page 2 人房接 `MeshGameBus` + mesh typing +
  房主=X；🔒 指示器/遊戲鈕/橫幅改按 mesh 現況（已 E2EE, keyx）與 2 人房閘控。
  **`tests/e2e-vue/rejoin.spec.ts` 由 fixme 轉綠（連跑 3 次穩定）**——「離開再進
  收不到」整類消滅：重進＝cold→syncing→live，B 重連 mesh、缺的訊息由留房者經
  anti-entropy 補齊。前兩次修復卡在的 star signaling 復活術，整個繞過。

驗收：全 Vue E2E 套件綠（golden-path/game-theme/rejoin×3/mesh-diagnostic/mesh-e2ee/
all-offline-revival/friends/persistent-rooms/room-manage/mesh-rejoin）；單元 1196 綠；
React 護欄未迴歸。

### 收尾（2026-07-07，接續本修訂當日完成）

修訂五當下記的兩條誠實邊界已於同日收尾階段關閉：

- **① 2 人房 Firestore 備援改密文**（commit 收尾①）：`GossipMessageHandler`
  加 `encryptForFallback/decryptForFallback`（房間金鑰 + 金鑰環按 epoch 選鑰），
  逐層透出到 `MeshChatService`（映射 `FallbackEncryptedContent`）。chat page 的
  `sendMessage` 改 mesh-first store-first：一律先入 gossip 日誌，覆蓋不足才**加密**
  橋接；無金鑰則不送明文（靠 anti-entropy 補）。備援層明文洩漏消除。
- **② star 死碼清除**（commit 收尾②）：`StarTopologyController` 與 `starTopology.ts`
  刪除，chat page 的 star 分支/輪詢/typing-star 分歧/`decideTopology` 全移除，
  `Topology` 型別收斂為 `'mesh'`。全 Vue E2E 套件（11 spec）仍綠。

---

## 修訂六（2026-07-07）：P4-A 全站節點名冊地基（盲信使前置）

盲信使（R1 / ADR-0024）＝非成員為他人房間保存密文複本並參與補齊。硬前提「紀錄
密文化」已由 P2-②c 完成，剩下的地基是「非成員怎麼找到要幫誰、怎麼連上」。P4 依相依
分四塊：**A 名冊 → B 陌生節點 signaling → C 寄存/對帳 → D 計量**。本修訂交付 **A**。

盤點發現 `src/core/relay/` 與 `transport/` 有大量休眠但已測的模組（`RelayManager`/
Sphinx/`RelayDirectory`(記憶體)/`RelayOverlay`/`RelayCoordinator`/`StoreAndForward`），
0 個 app 檔引用。`RelayCoordinator` 自己標注「全域 overlay 尚未建立」。故 P4 多為接線。

- **P4-A.1**（commit）：`FirestoreRelayDirectory` — `IRelayDirectory` 的 production
  adapter，宣告寫 `relayDirectory/{ownerUid}`，query 濾 TTL/exclude/sort/limit（對齊
  記憶體版語義）。firestore.rules：只能寫自己那格（docId==auth.uid、ownerUid 相符、
  非匿名反女巫、announcedAt ±60s）、任何登入者可讀。單元 4 + 整合 rules 7 綠。
- **P4-A.2**（commit）：`useNodePresence` — dashboard 掛載即宣告本節點（nodeId=mesh
  userId）+ 週期查在線節點數，離頁撤回；誠實條款（只有非匿名宣告成功才顯示，匿名/
  被拒靜默降級）。UI「還有 N 個節點一起守護」。E2E：兩瀏覽器 dashboard 互相發現。

**P4-B（done）**：不綁房的站級 signaling（`relaySignals/{channelId}`，rules 驗 participants）
+ `RelayConnector` 編排（主動 connectToRelayNode／中繼 startListening，對稱去重）。relay 連線
複用 `P2PManager`（DataChannel + HELLO + ICE restart 全套），不為 relay 重寫半套 WebRTC。
真 WebRTC E2E 綠：兩瀏覽器陌生節點雙端 connected（`tests/e2e-vue/relay-connect.spec.ts`）。

**P4-C（done，剩簽章/觸發收尾）**：盲信使寄存協議。
- C.1 `CourierStore`：ADR-0024 儲存經濟學（單筆 4KB／單房 5MB／總預算配額、14 天 TTL、
  預算 LRU 淘汰整房、簽章墓碑刪除、first-write-wins）。純邏輯，unit + property 測試。
- C.2 `CourierService`：deposit/pull/tombstone 協議跑在 P2PChannelBus（ns='courier'），
  request/response 關聯 + 逾時。整合測試（記憶體對接 bus）綠。
- C.3 接真 relay 通道：member 寄存密文紀錄 → courier 代管 → 回線 pull 原樣取回，
  真 WebRTC E2E 綠（密文位元對位相同，證明盲存不改 byte）。
- C.4 anti-entropy 自動對帳（reconcile）：複用 `antiEntropy` 的 computeDigest/peerLacks，
  一輪雙向收斂——成員送 digest → 信使補「成員缺的」+ 回自己 digest → 成員回推「信使缺的」。
  整合測試（含 missing 洞、已一致無多餘傳輸）+ 真 WebRTC 雙向 E2E 綠。
- C.5 app 觸發整合（`useCourierNode`，dashboard 掛載即啟）：
  - 信使角色 always-on：RelayConnector.startListening → 對每條來連掛 CourierServer（共用 CourierStore）。
  - 成員背景備份：每 30s runCourierBackup — 發現候選信使（新鮮者優先、上限 4，多候選容忍
    崩潰未撤回的陳舊名冊條目：連線到不了 'connected' 即換下一個）→ 對「持久層持有紀錄的每一房」
    reconcile（推信使缺的、收信使有我缺的並落地 IndexedDB）。
  - 預設參與、可關（localStorage `nerilo.courier.enabled`，ADR-0024 Decision 3.4）；關頁即停。
  - 真 production E2E 綠：成員 seed 一筆持久紀錄 → runCourierBackup（真 deps）→ 線上信使收下
    （100% production 路徑，只不等 30s interval）。listRooms 加進 IGossipPersistence。
- C.6 房籍簽章墓碑（`TombstoneCrypto`，ADR-0024 Decision 3.3）：盲信使不知名冊，如何驗房籍？
  觀察每筆代管密文都帶寄件人簽章、senderId=hash(pubKey)。故墓碑由「senderId 出現在該房
  store 的 pubKey」簽 `TOMBSTONE|${roomId}`；信使驗①簽章對得上②senderId∈roomStore → 刪。
  非成員沒對該房送過東西 → senderId 不在 store → 偽造驗不過。綁 roomId 防跨房重放。
  真 crypto 單元測試（簽/驗、非成員、竄改、跨房、冒用 pubKey、畸形）+ 協議整合 + 真 WebRTC
  E2E 綠。app 觸發：房間真刪（softDeleteRoom=='deleted'）時 dashboard 簽墓碑 best-effort 廣播。

**P4-C 完成。**

**P4-D（done）計量：共簽收據 → 點數（ADR-0022「中繼即價值」）。**
- `CourierReceipts`：具體 ECDSA 字串簽/驗 + pubKey↔nodeId 綁定 + verifyCoSignedReceipt（三關：
  雙 pubKey 綁定 + CoSignedReceipt 雙簽有效 + 非自簽自）。真金鑰單元測試。
- 協議（CourierService）：IDENTIFY（成員自報身分，可靠遞送＝等 ack 重試）→ 信使代管 bytes
  累計 → claimCredit 起草簽 → 成員驗 relay 半簽 + 綁定 + approve → 回簽 → 信使驗三關 → 計點。
  信使一個人偽造不了（沒成員回簽不成立）；成員冒名不了（pubKey 必須導出 nodeId）。
- app 觸發（useCourierNode）：信使 CourierServer 帶計量設定（onCredit→CreditEconomy
  .recordRelayContribution，落 CreditLedger 可驗帳本）；成員 CourierClient 自動回簽；每 30s
  claim 一輪。餘額帳戶以 firebase uid 為鍵（與 useCredits 一致），收據身分用 mesh nodeId。
- 真 WebRTC E2E 綠：成員寄存 → 信使起草+成員回簽 → 信使餘額增加 + 帳本 verify ok。
- 誠實邊界：CourierStore + CreditEconomy 目前記憶體/localStorage（best-effort，ADR-0024 定位）；
  in-flight 收據無逾時回補（成員不回簽則該輪 bytes 作廢，best-effort）。

**P4（網絡）全數完成：A 名冊 · B 連線 · C 盲信使寄存/對帳/墓碑 · D 計量。**

**尚未做（P4-D）**：共簽收據→點數計量（ADR-0022，`CoSignedReceipt` 已備）；多副本 K=3。
