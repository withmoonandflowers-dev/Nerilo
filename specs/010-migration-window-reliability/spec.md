# Spec 010：收斂星型→mesh 遷移窗訊息可靠性

- 軌別：feature（單一實作內的可靠性缺口；拍板路線不動 gossip 線上格式，維持 feature 軌）
- 狀態：done
- 建立：2026-07-18／最後更新：2026-07-18（同日拍板、實作、驗收全綠收尾）
- 關聯：ADR-0023（room-as-replicated-log；修訂五 P2-③ star 退役＝Vue 線已消滅本問題類）、ADR-0017（Vue 切 production 門檻）、ADR-0004（星型 E2EE）、docs/QA-REPORT-chat.md 行 151-153（已知限制原始記載）、.claude/skills/mesh-correctness（殘留清單第 2 項）、Spec 009（殘留第 1 項，同族但獨立）

## 1. 要做什麼、為什麼（specify）

React 產線的房間拓撲是分層的：2 人星型（`P2PManager` 直連）、第 3 人加入時切 mesh（`MeshGossipManager` gossip + anti-entropy）。切換是「拆掉星型棧、另起 mesh 棧」——兩個棧的訊息儲存、傳輸、身分與加密域互不相通。星型時代與切換過程中送出的訊息只存在於星型棧與寄件者本機，mesh 的 seq-based anti-entropy 對帳（恰好一次的補償機制）管不到它們：成員在錯誤的時刻送訊會無聲掉信，遲到者永遠補不到星型時代的歷史。診斷 E2E 目前靠「等 mesh 模式訊號才發送」繞開這個窗，等於自我揭露地把窗排除在保證之外。本 spec 要把「遷移窗內的訊息可靠性」收斂成有明確保證、有回歸鎖的狀態。

**關鍵現況（左右整個方向，先講明）**：Vue 接班線已於 2026-07-07（ADR-0023 修訂五，P2-③）把 star 特例整個退役——2 人房從第一則訊息起就走 gossip 複寫日誌，store-first、anti-entropy 補送、加密備援橋接，**由設計消滅了「兩個棧」這個問題類**，並有 `tests/e2e-vue/rejoin.spec.ts` 等回歸鎖。因此本問題今日只存在於 React 產線；而 React 已凍結新功能、Vue 切 production 觀察期最早 2026-07-30 屆滿（ADR-0017）。「修 React」與「靠 Vue 切換收斂」是本 spec 最大的路線抉擇（見 Q1）。

### 1.1 掉信劇本盤點（2026-07-18 逐檔核對程式路徑推導）

- **W1 星型時代歷史對遲到者永久缺失**：星型訊息由 `ChatService` 走 DataChannel、存本機 `chatStorage`（IndexedDB，依 roomId 鍵），從未進入任何 gossip store。第 3 人加入後，mesh anti-entropy 只能對帳 gossip store 內容，星型時代訊息無從補送——遲到者的房間歷史從 mesh 切換點才開始。原有兩名成員各自本機 loadHistory 看得到，形成三方視圖永久分歧。
- **W2 非對稱切換窗的無聲掉信（最尖銳）**：切換由各端的 Firestore snapshot 各自觸發，時點不同步。成員 B 已執行 `starTopology.cleanup()`（同步關閉 P2PManager）而成員 A 尚未收到 snapshot、仍在星型棧上送訊：A 的 DataChannel send 是 fire-and-forget，B 端棧已拆、訊息落地無門；A 端 UI 卻在 1.5 秒後顯示「已送達」（見 W5）。無任何機制事後補償——mesh store 與 Firestore 備援都沒有這則訊息。
- **W3 本機切換進行中的送訊**：`initializeP2P` 先 `architecture.decide()`（同步把架構旗標翻成 mesh）→ `starTopology.cleanup()` → `await meshTopology.initialize()`。窗內送訊走 `connectionState !== 'connected'` 分支 → mesh 房備援 → `sendMessageViaFirestore(roomId, uid, { content })` **明文**上 Firestore（React mesh 房備援本來就明文，UI 誠實標示；但星型時代同一房是 E2EE 的，切換讓同一房間的保密等級無預警下滑）。另有併發競態：send 讀到過期旗標組合時直接 throw（`MeshChatService not initialized` 或 star `ChatService not initialized`）→ 訊息標 failed，可見可重送，非無聲掉信但體驗粗糙。
- **W4 切換期重複**：QA 第三輪實測記錄「切換重載時重複或遺失」（`tests/e2e/mesh-diagnostic.spec.ts:14-17` 檔頭註解）。同則訊息可能經星型棧與 Firestore 備援兩條路徑到達，而「一則訊息一個 id 貫穿三路」的去重修復只涵蓋單一棧內；跨棧切換重載時 id 貫穿不完全即現重複。
- **W5 加重因子——「已送達」是模擬的**：React 與 Vue 的 `sendMessage` 都在送出 1.5 秒後 `setTimeout` 直接把狀態改 delivered（React `ChatPage.tsx:512-514`、Vue `[roomId].vue` 同型），非任何回執實據。掉信因此對寄件者完全不可見，違反誠實邊界精神（憲法第 10 條）。是否納入本 spec 見 Q4。

### 1.2 現況錨點（2026-07-18 逐檔核對）

- `src/features/chat/hooks/useP2PArchitecture.ts:23-62`：拓撲決策——3+ 人或房間標記 mesh → mesh；2 人 → star。`decide()`（行 70-74）同步更新 `currentArchitectureRef`，早於實際棧切換完成，是 W3 競態的來源之一。
- `src/features/chat/ChatPage.tsx:283-291`：★ MIGRATION 區塊——`starTopology.cleanup()` → `setConnectionState('connecting')` → `await meshTopology.initialize(...)`。互斥鎖 `migrationInProgressRef`（行 264-265）只防本機並行初始化，不解跨端非對稱（W2）。
- `src/features/chat/ChatPage.tsx:453-519`：送訊路由——connected+mesh 走 gossip（行 475）＋覆蓋不足時**明文**橋接（行 484-487，對比 Vue 已是加密橋接）；connected+star 走星型棧（行 489）；未連線時 star 走密文備援、mesh 走明文備援（行 497-509）；行 512-514 模擬 delivered（W5）。
- `src/features/chat/hooks/useStarTopology.ts:236-257`：`cleanup()` 同步 `p2pManager.close()`＋清空 chatService/senderKeyManager——星型棧即刻不可收（W2 的接收端條件）。
- `src/features/chat/MeshChatService.ts:143-167、274-276`：mesh 送訊先入 gossip store（`meshGossipManager.sendMessage`）再存本機；`loadHistory()` 只讀本機 chatStorage。gossip senderId 是 mesh userId（hash pubKey，行 48-50），星型訊息的 `from` 是 firebase uid——**兩棧身分域不同**，任何「星史注入 mesh store」方案都得先解身分對映與簽章歸屬（星型訊息沒有 gossip 簽章）。
- `web-vue/app/pages/chat/[roomId].vue:20-21、197-255、354-401`：Vue 線現況——`type Topology = 'mesh'`（star 已退役）；`initializeP2P` 一律 mesh；`sendMessage` store-first（「此刻沒連上也會由 anti-entropy 補送」）＋覆蓋不足時**加密**橋接、無金鑰不送明文。本問題類在 Vue 線不存在。
- `docs/adr/0023-room-as-replicated-log.md:227-261`（修訂五與收尾）：star 退役的三階段做法、`rejoin.spec.ts` fixme 轉綠＝「離開再進收不到」整類消滅的定義性驗證。若 Q1 拍板移植 React，此為既證實可行的施工圖。
- `tests/e2e/mesh-diagnostic.spec.ts:13-17、75`：診斷測試等 `.e2ee-indicator-dtls`（mesh 模式訊號）後才發送，檔頭註解自我揭露「星型時代送出的訊息屬於另一個傳輸棧，mesh 對帳管不到（實測會在切換重載時重複或遺失）」。本 spec 收斂後這段註解與 gating 是否移除，見 Q3。
- **消歧義（別混的兩個「migration」）**：`src/types/index.ts:55、579-588`（`hostMigrationEpoch`、`HostMigrationEvent`）與 `src/services/RoomService.ts:668-740`（`ownerLeaveRoom`）是**房主易主**——Firestore 房間文件所有權交接（狀態 open/closed、心跳交接），訊息不經房主中轉，與拓撲遷移無關；`src/core/game/sdk/GameSession.ts` 的 host migration 是遊戲會話層，同樣無關。本 spec 只處理**星型→mesh 拓撲遷移**。
- SDK（`src/sdk/`）只走 `MeshChatService` 路徑，無星型棧，不在影響面。

### 1.3 憲法檢核（constitution.md）

- 目標函數加分項：隱私韌性（消滅無聲掉信＝韌性主張的完整性；W3 的保密等級下滑也在此項）；可嵌入（SDK 雖不受影響，但「恰好一次」對外敘事目前帶著已知例外）；補助競爭力（QA 已知限制清單再收斂一項）。
- 四條不變量影響：
  - 恰好一次：**有，本 spec 就是恰好一次的最後一個已知結構性缺口**（mesh 內已達標，缺口在棧切換縫）。
  - E2EE 機密性：有條件。路線 (a)（star 退役移植）會把 2 人房從星型 SenderKeyManager E2EE 換成 mesh keyx 房間金鑰——加密域轉換必須明確聲明不降級；W3 明文備援下滑亦屬此項。
  - 點數帳本正當性：無（不動信使與帳本路徑）。
  - 身分與授權：間接。星型（firebase uid）與 mesh（mesh userId）身分域不同，涉及星史搬移的方案（Q2 選 b）才會碰到。

## 2. 邊界（明確不做）

- 不做殘留清單第 1、3、4 項（跨會話重放＝Spec 009、6+ 人拓撲、mesh 群組 E2EE）。
- 不動 anti-entropy 對帳演算法本體與 gossip 線上格式（若 plan 發現必須動，升 protocol 軌重走流程）。
- 不處理房主易主（`hostMigrationEpoch`／`ownerLeaveRoom`）與 `GameSession` host migration——兩者與拓撲遷移是不同機制（見 1.2 消歧義），僅在驗收時確認未被本 spec 弄壞。
- 不做 React mesh 房備援橋接的密文化 parity（Vue 已密文、React 明文）——那是 ADR-0017 P0/P1 parity 線的既有項目；本 spec 只在 W3 揭露其與遷移窗的交互，不擴大戰場。
- 不做跨裝置歷史備份與多副本合併（CURRENT-STATUS 既列獨立優先項）；Q2 若拍板「歷史」入範圍，也僅指同房間內遲到者經 mesh 補齊，不含跨裝置。
- 不提前 Vue 切 production、不縮短 ADR-0017 觀察期（若 Q1 拍板路線 b，本 spec 的交付掛在切換門檻上，而非改門檻時程）。

## 3. 待釐清（clarify）——2026-07-18 使用者全數拍板

- [x] **Q1 修復路線**（互斥，決定整個 spec 的形狀）：**拍板 (b)**——React 不動刀，靠 Vue 切 production 收斂。理由：Vue 線已由設計消滅問題類，對凍結中且即將退役的 React 線動刀是高風險低殘值；本 spec 交付改為 Vue 遷移窗回歸鎖 E2E＋文件重分類＋門檻掛鉤（Q5）。
  - (a) **把 star 退役移植回 React 產線**：對齊 ADR-0023 P2-③，2 人房 mesh 起步，問題類同構消滅。施工圖已有（Vue 三階段），但這是對「唯一 production 線」的大改，違反 React 凍結新功能的既定決策，且該線最早兩週後就被 Vue 取代——高風險低殘值。〔未採〕
  - **(b) React 不動刀，靠 Vue 切 production 收斂本項**〔採用〕：把殘留項重新定性為「React 線限定的架構債，由切換退役」。本 spec 交付：(1) Vue 線的遷移窗回歸鎖 E2E（證明「第三人加入的同時送訊」不掉不重，把 Vue 的免疫從設計主張變成測試事實）；(2) 文件重分類（QA 已知限制、mesh-correctness 殘留清單、CURRENT-STATUS、CROSS-MACHINE-HANDOFF 標明 scope=React-only 與收斂路徑）；(3) 掛進切換門檻（Q5a）。代價（誠實記錄）：切換完成前 production 使用者持續暴露在 W1-W4，切換若延期，暴露期跟著延長。
  - (c) **React 窗內最小緩解**：只緩解 W2/W3，W1 不解；在將死的程式碼上蓋新機制，仍需完整回歸成本。〔未採〕
  - (d) **星史注入 mesh store**：撞身分域對映、簽章歸屬、加密域轉換三座硬牆。〔否決〕
- [x] **Q2 需求範圍**：**拍板 (c)**——W1（React 線遲到者看不到切換前歷史）明確劃出範圍、記為誠實邊界，直到 Vue 切換退役整個星型棧。遷移窗訊息（W2/W3/W4）由 Vue 線設計保證＋本 spec 回歸鎖固定。
- [x] **Q3 驗收口徑與回歸鎖形式**：**拍板 (a)**——新增 Vue E2E：三人房「第三人加入的同時」三方連發訊息（不等 mesh 就緒訊號），矩陣全 =1，把 React 診斷測試刻意繞開的時窗直接納入斷言。React `mesh-diagnostic.spec.ts` 保留 gating，但檔頭註解改指向本 spec 與收斂路徑。
- [x] **Q4 「已送達」誠實化（W5）**：**拍板 (b)**——不入本 spec，另開獨立工作項（React/Vue 一起處理避免 parity 分歧；主 session 已立待辦）。
- [x] **Q5 收斂承諾掛在哪**：**拍板 (a)**——「Vue 遷移窗回歸鎖綠」掛進 ADR-0017 切換門檻清單，成為切 production 必要條件之一（使用者已同意動門檻清單）。

## 4. 技術計畫（plan）

路線 (b) 的方案：不動任何 `src/` 運作中程式碼，交付「測試事實＋文件真相」兩塊。

1. **Vue 遷移窗回歸鎖**（新檔 `tests/e2e-vue/migration-window.spec.ts`，標 `@vue-stable`）：
   - 劇本：A 建房、B 加入成 2 人房並互送訊息確立基線（React 線此階段＝星型時代）；接著 C 加入，**與 C 的加入並發**，A、B 立即連發訊息（不等 C 就緒、不等 mesh 橫幅、不等「已連線」狀態——這正是 React 線的 W2/W3 掉信窗），C 進房後在頁面允許的第一時間送訊（送失敗按重送——fail-visible 是 Vue 線的明訂行為，重送不破恰好一次因 id 貫穿）。
   - 斷言：窗內三則訊息 × 3 個畫面矩陣全 =1（count==1 同抓漏與重）；2 人時代基線訊息在 A、B 畫面各恰好 1。C 對 2 人時代歷史的可見性另行紀錄不入斷言（屬新成員歷史補齊語義，與遷移窗獨立；Vue 線由 anti-entropy 覆蓋、rejoin.spec 已鎖回歸類似路徑）。
   - 誠實條款：送達 deadline 需涵蓋 C 的 WebRTC/ICE 成形（模擬器下合法 30-60s，既有套件同語義），不是放寬對帳時限；重複沉澱 5s 後才斷言 count。
   - 跑法沿用既有：`firebase emulators:exec --only auth,firestore --project nerilo "playwright test --config playwright.vue.config.ts ..."`。
2. **React 診斷測試註解改向**：`tests/e2e/mesh-diagnostic.spec.ts` 檔頭「獨立於本輪目標，記錄於 QA 報告」改指向 Spec 010 與收斂路徑（gating 保留，行為零改動）。
3. **文件重分類**（把「遷移窗」從全案已知限制改為 React-only 誠實邊界）：`docs/QA-REPORT-chat.md` 已知限制該項、`docs/CURRENT-STATUS.md` 已知風險節、`docs/CROSS-MACHINE-HANDOFF.md` 相關記載、`.claude/skills/mesh-correctness/SKILL.md` 殘留清單第 2 項。
4. **ADR-0017 門檻清單**：切換門檻加一條「Vue 遷移窗回歸鎖（migration-window.spec）綠」。
5. **回填 ADR-0036**（migration-window disposition；原編 0033 因與 Spec 009 撞號重編）：記「為何不修 React、靠接班線收斂」的取捨與門檻掛鉤——這是看 diff 看不出來的決策理由。

取捨（為何 A 不 B）：修 React（路線 a/c）花在兩週後退役的程式碼上且風險最高；本方案的風險是「暴露期＝切換前」，以掛門檻（第 4 點）確保收斂承諾不淪為口頭。

## 5. 任務分解（tasks）

- [x] T1：新增 `tests/e2e-vue/migration-window.spec.ts`（依 plan 第 1 點劇本與斷言），本機連跑 3 次穩定（house style）。
- [x] T2：`tests/e2e/mesh-diagnostic.spec.ts` 檔頭註解改指向 Spec 010（不動測試行為）。
- [x] T3：文件重分類——QA-REPORT、CURRENT-STATUS。〔實作期修訂〕CROSS-MACHINE-HANDOFF 逐字核對後**無**遷移窗記載（該文件為 2026-07-03/04 時點的操作交接，早於 QA 第三輪），無可改之處；mesh-correctness skill 檔只存在主 checkout 未追蹤區（worktree 隔離下不可觸碰），殘留清單第 2 項的更新交回主 session 收尾。
- [x] T4：ADR-0017 門檻清單加第 6 點；回填 ADR-0036（含 ADR README 索引）。
- [x] T5：驗收——`npm run ci` 全綠＋新 E2E 綠；spec 狀態改 done。

（無任務動運作中 production 路徑，故無 ⚠；T1 是純新增測試檔。）

## 6. 驗收（黃金判準）——2026-07-18 全綠

- [x] V1 遷移窗回歸鎖轉綠：`tests/e2e-vue/migration-window.spec.ts` 三人並發窗內矩陣全 =1，連跑 3 次穩定（29.0s／32.9s／25.1s；C 對 2 人時代歷史的可見性三次皆為 1 1，僅記錄不斷言；第 2、3 次實測觸發 C 的 fail-visible 重送路徑仍恰好一次）。
  - **2026-07-18 合併期修訂（使用者拍板，spec 活文件條款）**：與 Spec 012 出口閘合流後，
    「與 C 加入並發的訊息」可能以 C 未受封的房間金鑰 epoch 加密——「新人不解加入前
    內容」是 012 已鎖密碼學語義（`MeshKeyxIntegration.spec`），與 009「舊代不補」同一
    安全取向。本 spec 原斷言依賴的形成期明文窗已被 012 關閉（該窗本身是要修的洩漏）。
    裁決＝縮小斷言：既有成員（A、B）之間任何時窗訊息恆恰好一次、C 加入後的訊息全員
    恰好一次；C×並發格可見與否不斷言（收到即不得重複）。React 線繞開的「掉信窗」
    主張不變——對既有成員「不重不漏」仍被直接斷言。
- [x] V2 既有回歸鎖不動搖：`npm run ci` 全綠（type-check、lint、單元 132 檔／1477 tests——基線因平行線新增測試已高於 spec 撰寫時的 124／1421，全數通過；內含 antiEntropy 模擬、五根因回歸鎖、`RoomServiceHostMigration.spec`）。
- [x] V3 React 診斷測試零行為改動（只動註解），Vue 既有 `@vue-stable` 不受新檔影響（新檔為獨立 spec 檔、獨立房間）。
- [x] V4 收尾文件落地：QA-REPORT、CURRENT-STATUS、ADR-0017、ADR-0036、ADR README 全數更新且相互一致（皆指向 Spec 010）；CROSS-MACHINE-HANDOFF 與 mesh-correctness skill 見 T3 實作期修訂。

## 7. 一致性自查（analyze，2026-07-18 implement 前跑過）

- [x] 第 4 節方案覆蓋第 1 節全部需求（W2/W3/W4→回歸鎖；W1→誠實邊界文件化（Q2c）；W5→範圍外另立項（Q4b）），無多做
- [x] 第 5 節任務完整實現第 4 節（T1↔plan1、T2↔plan2、T3↔plan3、T4↔plan4+5），無遺漏
- [x] 第 6 節驗收能證明第 1 節：V1 直接斷言 React 線繞開的時窗在存續線上不掉不重；V4 證明文件與真相一致，不是只證明「程式跑得動」
- [x] 未違反憲法任何一條：不動運作中路徑（第 6 條不觸發）、React 凍結決策維持、誠實條款（deadline 語義聲明於 plan）、切換門檻變更已獲使用者同意（Q5a）
