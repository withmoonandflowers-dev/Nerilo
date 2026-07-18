# Spec 012：收斂 mesh 群組 E2EE 第二階段——關明文窗、堵盲信使明文外洩、立每通道安全分級

- 軌別：feature＋protocol 局部加嚴（Q3 拍板收側拒收規則、Q6 拍板安全標籤契約，兩者屬跨實作互通層：規則以實作無關形式定義於第 4 節並附 conformance 測試向量）。
- 狀態：implementing（clarify 已於 2026-07-18 全數拍板）
- 建立：2026-07-18／最後更新：2026-07-18
- 關聯：ADR-0004（星型 E2EE 接線；mesh 群組金鑰當時列第二階段）、ADR-0023（P2 紀錄密文化＋keyx 分發，已完成上線）、ADR-0024（盲信使儲存經濟學；盲性前提）、ADR-0026（R2 明文降級 fail-visible，已落地）、ADR-0010（異質傳輸分級契約，Proposed）、ADR-0031（TreeKEM/GroupKeyManager 處置懸置）、docs/GOAL-ANALYSIS.md GS1/GS4/GX3、.claude/skills/mesh-correctness（殘留清單第 4 項）
- 排程協調（非阻塞依賴）：Spec 009（session epoch 入簽章）另線進行中，動的是簽章覆蓋範圍與 gossip wire；本 spec 全部方案落在內容層（RecordCrypto 信封在簽章之前）與應用層閘門，不碰簽章語義。兩 spec 若同期實作，courier 相容性與 `GossipMessageHandler` 的改動需協調合併順序。

## 1. 要做什麼、為什麼（specify）

ADR-0004 當年把「mesh（3 人以上）群組金鑰分發」列為第二階段。該主體已由 ADR-0023 P2（修訂三至五）完成並上線：mesh 房走房間內容金鑰（keyx 紀錄分發、RecordCrypto 單一密文信封、簽章覆蓋密文、名冊變動輪替 epoch），Vue 線 2 人房也已切 gossip 管線且備援密文化。mesh-correctness skill 殘留清單第 4 項寫的「mesh 3+ 人群組金鑰仍 dormant」已過時。

但 2026-07-18 逐檔核對後，「第二階段」仍有六個真實缺口（見 1.2）：金鑰就緒前的明文窗、盲信使備份不過濾明文紀錄、React 產線 mesh 備援仍寫明文 Firestore、金鑰輪替節奏與前向保密語義未拍板、TreeKEM/GroupKeyManager 處置懸置、以及 GX3「每通道安全標籤」只有目標樹記載沒有原語。本 spec 要把這六個缺口逐一收斂或明文記錄為刻意取捨，讓「mesh 群組 E2EE」從「主路徑已加密」升級為「所有出口一致加密、降級可見、分級有原語」。沒有它：形成期訊息與明文相容房的紀錄會以明文寄存到非成員信使（違反 ADR-0023 自己寫下的硬前提「紀錄仍為明文前，任何給非成員存＝洩露」）、React 產線持續把 mesh 訊息明文寫進 Firestore、而 GX3 分級契約會在 M4 平台抽取時缺席，之後補是破壞式變更（ADR-0010 Context 的風險預言）。

### 1.1 現況錨點（2026-07-18 逐檔核對）

已完成、本 spec 不重做，僅作為地基：

- mesh 內容加密 live：`src/core/mesh/GossipMessageHandler.ts:197-213` 送出時金鑰就緒即以 RecordCrypto（`nrec1` 信封，AES-256-GCM）加密 content，加密在簽章之前，簽章覆蓋密文；`keyRing` 按 epoch 選鑰（行 62-87）；store／轉發／對帳一律密文原封。`channel:'keyx'` 例外不再加密（其 content 本身是成對 ECDH 封裝）。
- keyx 分發 live：`src/core/mesh/MeshGossipManager.ts:181-207` 注入 ECDH 私鑰並建 `RoomKeyCoordinator`；`src/core/mesh/RoomKeyCoordinator.ts` 三道閘門（全員 ecdh 就緒、名冊連續穩定、最小 userId 為產生方）＋名冊變動即新 epoch 新金鑰（移除成員的前向保密）；`rosterFromRoom` 以 meshIdentities ∩ participants 排除離開者。
- 備援密文（Vue 線）：`GossipMessageHandler.encryptForFallback/decryptForFallback`（行 106-126）；`web-vue/app/pages/chat/[roomId].vue:378-391` 覆蓋不足時密文橋接、無金鑰則不送明文（靠 anti-entropy 補）。
- 降級 fail-visible（ADR-0026 R2）：`MeshGossipManager.getEncryptionState()`（行 604-615，三態 encrypted/exchanging/plaintext）、`src/features/chat/encryptionGate.ts`（只有 plaintext 需阻斷式確認）、Vue 三態指示器＋明文房常駐提示。
- 盲信使盲性：`src/core/relay/CourierStore.ts` 只碰密文信封與簽章、不持金鑰；E2E `tests/e2e-vue/mesh-e2ee.spec.ts`（UI 明文、複本密文，keyx 紀錄不透明）綠。
- dormant：`src/core/crypto/TreeKEMManager.ts`（698 行、26 測試，O(log N) 群組金鑰，明載「assumes ordered delivery」）與 `GroupKeyManager.ts`（304 行、20 測試）零 app 引用；`RoomKeyDistribution.ts` 檔頭明言「刻意不用 GroupKeyManager 的重機」。ADR-0031 判「不動（待專門分析）」。
- `SenderKeyManager` 現僅 React 星型路徑使用（ADR-0004 注入，`src/features/chat/hooks/useStarTopology.ts`）；Vue 線 star 已退役。其 seq 重放檢查與 SecurityManager 簽章覆蓋範圍是本 spec 的硬邊界（見第 2 節）。

### 1.2 缺口清單（本 spec 的範圍主體）

**缺口一：exchanging 明文窗，且可被誘導成永久明文而不觸發 R2 閘門。**
`GossipMessageHandler.sendMessage` 在金鑰未就緒時送明文（行 197-213 的「明文相容」分支）；keyx 需全員 ecdh 就緒＋名冊穩定（約 4-8 秒起跳），形成期送出的訊息以明文進入永久 gossip 日誌，事後不回溯加密。`encryptionGate.sendDecisionFor` 只擋 'plaintext'（keyCoordinator=null），'exchanging' 放行不確認。攻擊面：成員（或故障的舊版 client）加入後不發布 ecdhPubKey，`RoomKeyCoordinator.tick` 閘門一永不滿足（行 95-103），房間永遠停在 'exchanging'——訊息持續明文、UI 只有一顆 🔑 指示、R2 的阻斷式確認永不觸發。這是 ADR-0026 R2「降級可被誘導」的殘餘變體。E2E `mesh-e2ee.spec.ts` 自己也註明「等 keyx 傳播……避免形成期空窗誤判」——測試繞開了這個窗，而不是證明它不存在。

〔實作期修訂 2026-07-18〕缺口一有一個隱藏成員：**重載後明文窗重開**。`GossipMessageHandler.hydrate` 只把持久紀錄回灌 store，不重放 keyx 紀錄進 `consumeKeyx`——重載後金鑰環是空的，而 keyx 紀錄已在自己 store 內（anti-entropy 不會重送給自己），名冊未變時產生方也不重發。結果：純重載（非重進）的成員停在 'exchanging'、送訊回到明文；若重載者恰是產生方，`getMaxKnownEpoch()` 因金鑰環空而回 -1，重發 epoch 0 與日誌中既有 epoch 0 碰撞（同代不同鑰）。修復（hydrate 重放 keyx）列入第 4 節 P2。

**缺口二：盲信使備份不過濾明文紀錄，明文外洩給非成員。**
`src/core/relay/CourierService.ts:592-646` `runCourierBackup` 把持久層每一房的全部紀錄推給信使（reconcile 推「信使缺的」），無任何 `isEncryptedContent` 過濾；信使收側（CourierServer/CourierStore）亦不驗 content 是否為密文信封。缺口一的明文窗紀錄、明文相容房（混版、無 ECDH 環境）的全部紀錄，都會以明文寄存到非成員信使。這直接違反 ADR-0023 修訂二寫死的硬前提：「紀錄仍為明文前，任何『給非成員存』＝洩露」，也讓 ADR-0024 的「盲」名不符實。注意豁免細節：keyx 紀錄（channel:'keyx'）的 content 是 `keyx1` JSON、不是 `nrec1` 信封，`isEncryptedContent` 會判 false，但 keyx 必須被信使保存（ADR-0023 修訂三：金鑰韌性＝資料韌性）——過濾規則必須 channel-aware，不能一刀切。

**缺口三：React 產線 mesh 備援與橋接仍寫明文 Firestore，且加密標示過時。**
core 的 mesh 加密是兩線共用，React mesh 房的 gossip 路徑其實已密文化；但 `src/features/chat/ChatPage.tsx:485`（mesh 覆蓋不足的混合橋接）與 `:508`（斷線備援）仍直接 `{ content }` 明文寫 Firestore——線上密文、伺服器明文，加密形同虛設。同檔行 668-741 的指示器把所有 mesh 房標為 `mesh-dtls`（「端到端加密尚未支援多人拓撲」）——低報（安全上保守方向），但與現況不符，且 React 無 plaintext 態與阻斷確認（ADR-0026 R2 已知邊界）。React 受 ADR-0017 凍結，但「持續進行中的明文洩漏」是安全修復不是新功能；怎麼切，Q1 拍板。

**缺口四：房間金鑰輪替節奏與前向保密口徑未拍板。**
現況只在名冊變動時輪替 epoch；穩定名冊的長壽房一把金鑰用到底（對照 SenderKeyManager 的 100 則／1 小時自動輪替）。關鍵架構事實，拍板前必須看清：keyx 是永久日誌紀錄，任何在籍成員（含遲入者）補齊 keyx 即可解全部 epoch 的歷史——這是「持久聊天室可補歷史」產品語義（nerilo-product-model）的刻意設計。因此**週期輪替在此架構下不提供對在籍成員的前向保密**（ECDH 私鑰洩露→可開全部 keyx→可解全部 epoch）；它只縮小「單一 epoch 金鑰本體外洩」的暴露面。真前向保密（ratchet＋刪舊鑰）與補歷史語義正面衝突。選哪個口徑、要不要加週期輪替，Q4 拍板並寫進威脅模型文件。

**缺口五：TreeKEM 與 GroupKeyManager 處置懸置。**
ADR-0031 明言「不碰 crypto……另立專門分析」，本 spec 就是那個分析的落點。事實面：TreeKEMManager 自述假設有序送達，與 gossip 最終一致、亂序、anti-entropy 補送的世界觀相悖；keyx-as-log-record 方案已在 live 驗證；3-5 人房每次名冊變動 O(N) ECDH 封裝成本可忽略，6-20 人（殘留清單第 3 項）亦僅 20 次 ECDH。留著的代價是 1,100 行最高風險模組的維護面積與「架構圖上有兩套群組金鑰機制」的敘事混亂。退役、續眠、或採用，Q5 拍板；完成後回填 ADR（ADR-0031 續篇）。

**缺口六：GX3「每通道安全標籤」只有目標樹記載，沒有原語。**
ADR-0010 Decision 1-2 已定原則：每個 transport adapter 宣告安全等級（e2ee／sign-only／plaintext），應用層宣告資料流最低等級，路由不得降級，預設 e2ee、降級顯式且 UI 可見。ham 頻段法規禁加密（台灣 NCC、美國 FCC Part 97），所以是分級不是一律加密——標籤是化解 GX3 對 GS1 衝突的機制。現況只有房級三態 `EncryptionState`，不是通道級標籤。今日各通道的實際等級盤點（標籤模型必須能表達這張表）：

| 通道 | 現況安全等級 | 備註 |
|---|---|---|
| gossip P2P（DataChannel） | e2ee（金鑰就緒）／plaintext（相容窗，缺口一） | 簽章恆有（sign 是底線） |
| Firestore 備援／橋接 | Vue：e2ee；React：plaintext（缺口三） | DTLS/TLS 只到伺服器 |
| presence 暫態通道（typing） | 傳輸層加密（DTLS），無簽章無 E2EE | 不進日誌，暫態信號 |
| 盲信使寄存 | 密文＋簽章盲存（但收明文紀錄不拒，缺口二） | ADR-0024 |
| warm 加密中繼（Spec 005） | 中繼盲轉密文 | 已完成 |
| ham／Meshtastic licensed（未來，僅藍圖） | sign-only（法規強制） | ADR-0010 M5，本 spec 不實作 |

本 spec 在 GX3 的責任範圍：把標籤與最低等級閘門定成型別契約與判定原語（`EncryptionState` 泛化），供 M4/M5 接入；不實作任何 RF 通道。範圍深度（純型別／含路由閘／含 UI）Q6 拍板。

### 1.3 憲法檢核（constitution.md）

- 目標函數加分項：隱私韌性（關閉現行明文洩漏路徑，E2EE 宣稱與行為一致——GP2 誠實原則）；可嵌入（安全分級是 SDK 對外契約的一部分，M4 前定形免破壞式變更）；補助競爭力（「災防離網通訊」敘事依賴分級標籤的法規相容設計，ADR-0010 Consequences）。
- 四條不變量影響：
  - 恰好一次：有。缺口一的送出閘與缺口二的過濾動 mesh 收送路徑周邊；不動去重鍵、簽章、anti-entropy 演算法本體，且受回歸鎖約束（`GossipMessageHandler.spec.ts` 補送案例、`antiEntropy.simulation.spec.ts` 多 seed、mesh-diagnostic 矩陣）。特別注意：信使側過濾若把「明文紀錄」擋在對帳之外，該紀錄仍須能經成員間 anti-entropy 補齊，不得造成掉信。
  - E2EE 機密性：核心。本 spec 主體即是把機密性從「主路徑」擴到「所有出口」。
  - 點數帳本正當性：間接。信使拒收明文（若 Q3 拍板收側驗證）改變寄存協議的接受面，影響 bytes 計量與收據（P4-D）；Protocol Spec 003 相容性須在 plan 聲明。
  - 身分與授權：無直接影響。不動簽章覆蓋範圍（硬邊界，見第 2 節）；標籤模型只消費既有簽章事實，不新增身分語義。

## 2. 邊界（明確不做）

- **不動 `SecurityManager` 簽章覆蓋範圍、不動 `SenderKeyManager` 的 seq 重放檢查**。Spec 009 另線正在動簽章語義（session epoch 入簽章），本 spec 全部候選方案都落在內容層（RecordCrypto 信封在簽章之前，簽章自然覆蓋密文）與應用層閘門，經核對不需要碰這兩處。若 clarify 後任何拍板方向演變為必須碰（例如把安全標籤簽進訊息），即停止並回報，由 Spec 009 線與本 spec 重新協調範圍，不得逕行修改。
- 不做跨會話重放防護（Spec 009）、遷移窗訊息可靠性（殘留清單第 2 項）、6+ 人拓撲實測（第 3 項）。
- 不實作任何 RF／衛星通道（Meshtastic、ham、Iridium）：ADR-0010 排 M5，且策略定調只當藍圖不碰無線電頻段。本 spec 只交付標籤契約與閘門原語。
- 不解多裝置同身分的金鑰同步、加密備份與私鑰復原（CURRENT-STATUS 既列的獨立優先項）。
- 不回溯加密既存明文紀錄（ADR-0004 先例：僅適用新訊息；已入日誌的明文紀錄簽章覆蓋明文，重加密會毀簽章）。對既存明文的處置僅限「要不要繼續外流」（缺口二）層次。
- 不動 React 凍結原則下與本 spec 無關的任何 React 功能；React 側改動範圍嚴格以 Q1 拍板為準。
- 不動 nuxt 版本（釘 4.4.2）、不動 Vue 切換門檻與觀察期節奏（ADR-0017）。
- presence 暫態通道（typing）維持 DTLS-only：暫態信號不進日誌、洩漏面是「誰在打字」的 metadata，升級為 E2EE 的收益與複雜度不成比例；在標籤模型中誠實標示其等級即可（若 Q6 拍板含 UI，另議呈現方式）。

## 3. 待釐清（clarify）——2026-07-18 使用者全數拍板

- [x] **Q1 React 產線的處置範圍**：拍板 **(a) 僅止血**。橋接／備援明文洩漏修掉（有金鑰才密文送、無金鑰不送）＋過時指示器文案修正；不做完整 parity（plaintext 態與阻斷確認留待切換決策）。
- [x] **Q2 exchanging 明文窗**：拍板 **(a) 送出閘**。金鑰未就緒不送、keyx 就緒自動補送、逾時轉 fail-visible（視同明文房走阻斷式確認）。逾時參數與 UX 於第 4 節 P2 定並記錄理由。
- [x] **Q3 盲信使明文過濾**：拍板 **(c) 推收兩側都做**。keyx 紀錄豁免、過濾 channel-aware；收側拒收規則走 protocol 軌加嚴（conformance 向量見第 4 節 P3）。被過濾明文紀錄的補齊路徑＝僅成員間 anti-entropy，信使不代管（文件記載，見 V7）。
- [x] **Q4 金鑰輪替口徑**：拍板 **(a) 維持名冊變動觸發**；威脅模型誠實記載「keyx 永存日誌、在籍成員可解全部歷史、無對在籍者的前向保密」。
- [x] **Q5 TreeKEM 與 GroupKeyManager**：拍板 **(a) 退役刪碼**，回填 ADR-0031 續篇（ADR-0033）。
- [x] **Q6 GX3 安全標籤**：拍板 **(a)+(b)**。型別契約＋`EncryptionState` 改衍生＋最低等級路由閘（與 Q2 送出閘收斂成同一原語）；不做 UI 每通道標示、不實作任何 RF 通道。
- [x] **Q7 驗收面**：拍板**四出口全做**——IndexedDB 複本、Firestore 訊息文件、信使儲存、exchanging 明文窗專項。

## 4. 技術計畫（plan）

### P1 安全標籤原語（Q6，protocol 軌：契約定義）

新模組 `src/core/security/securityLabel.ts`（core 層、零框架依賴；SDK 表面暫不匯出，M4 平台抽取時再上——避免 0.x 提前鎖 API）：

- `SecurityLevel = 'e2ee' | 'sign-only' | 'plaintext'`，全序 e2ee > sign-only > plaintext；`meetsMinimum(actual, min)`。
- `channelSecurityLevel(kind, ctx)`：通道→等級判定。定義（實作無關，以內容層機密性／完整性為準，傳輸層加密如 DTLS/TLS 不計入等級）：
  - `gossip`：房間金鑰就緒 → `e2ee`；未就緒 → `sign-only`（gossip 紀錄恆有 ECDSA 簽章，內容可讀）。
  - `firestore-fallback`：密文信封 → `e2ee`；明文 body → `plaintext`（無簽章）。
  - `presence`（typing 暫態）：`plaintext`（DTLS-only、無簽章、不進日誌）。
  - `courier`：`e2ee`（僅代管密文＋簽章；P3 的拒收規則使此宣告可驗證）。
- `sendGateDecision(state: EncryptionState, min: SecurityLevel) → 'allow' | 'hold' | 'confirm-degrade'`：達最低等級→allow；未達且可望改善（exchanging）→hold；未達且已定局（plaintext，含逾時衍生）→confirm-degrade。這就是 ADR-0010 Decision 2 的「路由不得降級、降級必須顯式」原語，與 Q2 送出閘同一實體。
- `deriveEncryptionState({initialized, coordinatorActive, roomKeyReady, exchangeTimedOut})`：R2 三態改為衍生值；新增規則「exchanging 逾時 → 'plaintext'」（fail-visible 升級；金鑰事後到位則衍生值自動回到 encrypted）。`MeshGossipManager.getEncryptionState` 改為委派此函數。

### P2 exchanging 明文窗（Q2-a；⚠ 運作中路徑）

- **hydrate 重放 keyx**（缺口一實作期修訂）：`GossipMessageHandler.hydrate` 載入紀錄後，將 store 中 `channel:'keyx'` 紀錄逐筆過 `consumeKeyx`（皆為當初驗簽後才入庫的紀錄）。重載後金鑰環重生、`getMaxKnownEpoch` 正確、產生方重載不再 epoch 歸零碰撞。這是本 spec 對 GossipMessageHandler 僅有的兩處改動之一（另一處為零：送出路徑不動——閘門放在 MeshChatService 層），Spec 009 rebase 面最小。
  〔實作期修訂二〕接線順序陷阱：`MeshGossipManager.initialize` 原先在 `hydrate()` **之後**才 `setKeyxPrivateKey`——無私鑰時 keyx 重放是 no-op，重載明文窗照舊重開（單元測試先注鑰遮住了此點）。已改為私鑰先注、hydrate 在後；教訓＝重放類修復必須核對「依賴注入時序」，不能只測重放函數本體。
- **逾時**：`MeshGossipManager` 記 `keyxStartedAt`（startKeyxCoordination 時），`KEYX_EXCHANGE_TIMEOUT_MS = 60_000`。理由：健康房 keyx 於 10 秒內完成（tick 4s＋穩定窗 1 tick＋傳播）；60s 與 mesh-diagnostic 現行拓撲等待同級，CI 慢環境不誤觸；DoS 窗上限 1 分鐘，期間指示器誠實顯示 🔑 且訊息一律暫扣不外洩。逾時後 `deriveEncryptionState` 回 'plaintext' → 既有 R2 阻斷式確認流接手；金鑰若遲到，狀態自動回 encrypted。
- **等待原語**：`MeshGossipManager.waitForSendKey(deadline)` 以 250ms 輪詢 `hasSendKey()`（零 GossipMessageHandler 改動）。
- **出口閘（MeshChatService）**：`sendMessage`／`sendGameEnvelope` 進入前過 `sendGateDecision(getEncryptionState(), 'e2ee')`：allow→送；hold→`waitForSendKey` 至房間逾時線，就緒即自動補送（原 promise 續走，UI 維持 sending 態），逾時拋 `PlaintextConfirmRequiredError`；confirm-degrade→直接拋。新增 `allowDegraded` 參數：使用者於 UI 明確確認後的明文送出走此參數（R2 語義）。`sendReaction`／`sendRead` 未達 allow 時靜默略過（皆為冪等聚合，之後可重送；明文窗內聊天本體被扣住，兩者實際無事可送）。typing 豁免（presence 通道，等級已於 P1 誠實宣告）。
- **Vue 頁**：送前 pre-check 沿用（逾時後狀態衍生為 'plaintext'，走既有 `plaintextPending` 確認 bar）；catch `PlaintextConfirmRequiredError` → 內容回填 `plaintextPending`（樂觀訊息標 failed 移除重複）；`confirmPlaintextSend` 改走 `allowDegraded`。
- **React 頁**：無確認 bar（Q1-a 不做 parity），catch 後標 failed——React 上「明文房送不出」是刻意的更嚴格止血姿態，記錄於文件。

### P3 盲信使明文過濾（Q3-c；protocol 軌：接受規則＋conformance）

**規則（實作無關定義）**：紀錄 r 為「信使合格」若且唯若——
1. `r.channel === 'keyx'` 且 content 可解析為 `v:'keyx1'` 的分發 payload；或
2. 其餘 channel（含未標）之 content 為合法 `nrec1` 密文信封（`isEncryptedContent` 語義：含 `"v":"nrec1"` 標記、嚴格 parse、ct/iv 為字串）。

**conformance 向量**（落 `tests/unit/CourierPlaintextFilter.spec.ts`，表驅動）：合格＝{合法 keyx1；nrec1 信封之 chat/game/reaction/read/未標}；不合格＝{明文 chat；明文 game/reaction/read；含 nrec1 標記但 parse 失敗；channel:'keyx' 而 content 非 keyx1；空字串}。

**落點**：`src/core/relay/courierEligibility.ts`（純函數 `isCourierEligibleRecord`）。推側：`runCourierBackup` 於 `buildRoomStore` 前過濾（digest 亦不宣告明文紀錄）＋`CourierClient.reconcile` 推送前防禦過濾。收側：`CourierStore.deposit` 拒收 `{accepted:false, reason:'plaintext-content'}`（單一收斂點，IOU 與非 IOU 路徑同過）＋`revive` 略過既存不合格紀錄（歷史遺留清洗）。Spec 003 相容：舊 client 推明文將被拒收——其紀錄本來就不該離開成員圈，拒收即協議意圖；合格密文紀錄照舊，wire 格式零變更。

### P4 React 止血（Q1-a；⚠ 運作中 production 路徑）

`src/features/chat/ChatPage.tsx`：mesh 橋接（行 485）與斷線備援（行 508）改經 `meshChatService.encryptForFallback`——有密文才寫 Firestore，無金鑰橋接跳過（featureLog 記 `fallback_skipped_no_key`）、備援標 failed 不明文出手。訂閱側 `decrypt` 依拓撲分流（mesh → `meshChatService.decryptFromFallback`）。指示器：保留 `.e2ee-indicator-dtls` class（`tests/e2e/mesh-diagnostic.spec.ts:75` 以它當 mesh 模式信號，不可改名），文字／title／aria 改依 `getEncryptionState()` 三態真值輪詢更新，撤下「端到端加密尚未支援多人拓撲」的過時宣稱。

### P5 TreeKEM／GroupKeyManager 退役（Q5-a）

刪除 `src/core/crypto/TreeKEMManager.ts`、`src/core/crypto/GroupKeyManager.ts`、`tests/unit/TreeKEMManager.spec.ts`、`tests/unit/GroupKeyManager.spec.ts`（−46 tests，基線同步更新）；`RecordCrypto.ts`／`RoomKeyDistribution.ts` 檔頭註解去除對 GroupKeyManager 的指涉；SDK 表面無此二者匯出（已核）。回填 `docs/adr/0033-retire-treekem-groupkeymanager.md`：理由＝有序送達假設與 gossip 亂序世界觀相悖、keyx O(N) 至 20 人尺度足夠、live 方案已驗證；復活路徑＝git 歷史。

### P6 文件與口徑（Q4-a）

`docs/THREAT_MODEL.md` 新增房間金鑰口徑（名冊變動輪替；keyx 永存日誌；在籍者可解全歷史；離開者無新 epoch；無對在籍者的前向保密——刻意取捨，理由＝補歷史語義）；`docs/CURRENT-STATUS.md` 基線與完成度、`docs/QA-REPORT-chat.md` 已知限制、`.claude/skills/mesh-correctness` 第 4 項改寫。

### 與 Spec 009 的合併順序聲明

本 spec 對 `GossipMessageHandler` 僅動 `hydrate`（keyx 重放）；009 動 verify 簽章語義與去重鍵 `(senderId, epoch, seq)`。hydrate 重放不依賴去重鍵形狀（keyx 紀錄按 channel 篩選），預期 rebase 衝突面極小。courier digest 過濾若遇 009 的 digest 分代（其 Q5），對齊責任在 009 側。

## 5. 任務分解（tasks）

- [ ] T1 ⚠ characterization：受影響單元基線綠（GossipKeyx／GossipContentCrypto／RoomKeyCoordinator／Courier*／encryptionGate／antiEntropy.simulation）後才動手。
- [ ] T2 P1 securityLabel 模組＋單元測試。
- [ ] T3 ⚠ P2 hydrate keyx 重放＋單元（重載重生金鑰環、產生方 epoch 不歸零）。
- [ ] T4 P2 MeshGossipManager 衍生狀態＋逾時＋waitForSendKey＋單元。
- [ ] T5 ⚠ P2 MeshChatService 出口閘＋`PlaintextConfirmRequiredError`＋單元（hold 自動補送／逾時確認／reaction-read 略過）。
- [ ] T6 P2 Vue 頁整合（confirm 流接 allowDegraded）＋`@vue-stable` 指示器回歸。
- [ ] T7 P3 信使過濾推收兩側＋conformance 向量＋revive 清洗。
- [ ] T8 ⚠ P4 React 止血（橋接／備援密文、訂閱分流、指示器三態文案）。
- [ ] T9 P5 TreeKEM／GroupKeyManager 退役＋ADR-0033。
- [ ] T10 P6 文件收尾＋第 6 節驗收全跑（四出口斷言：複本＝mesh-e2ee.spec 既有、Firestore＝新 E2E fallback 密文專項、信使＝T7 單元、明文窗＝T5 單元）。

## 6. 驗收（黃金判準，沿用 mesh-correctness skill 四層驗收；最終形狀依 Q7 拍板）

- [ ] V1 明文窗專項（Q2 拍板口徑）：金鑰未就緒期間送訊，依拍板行為斷言（不出手／確認後出手）；keyx 就緒後訊息如常送達且複本為密文；「成員不發 ecdh」劇本不造成無提示的永久明文。
- [ ] V2 信使明文過濾專項（Q3）：含明文紀錄的房執行 courier 備份，信使側不得出現明文 content；keyx 紀錄照常寄存；被過濾紀錄仍可經成員間 anti-entropy 補齊（恰好一次不破壞）。
- [ ] V3 React 出口密文（Q1 拍板範圍）：mesh 房橋接／備援寫入 Firestore 的訊息文件不含明文 content。
- [ ] V4 標籤模型（Q6 拍板深度）：通道→標籤判定與最低等級閘門的單元測試；`EncryptionState` 衍生後 Vue 三態指示器與 R2 阻斷確認行為不變（`e2ee-indicator.spec.ts` 回歸綠）。
- [ ] V5 回歸鎖不動搖：`GossipMessageHandler.spec.ts` 補送與 `maxAgeMs: null` 案例、`SecurityManager.spec.ts` 全數、`antiEntropy.simulation.spec.ts` 多 seed、`mesh-e2ee.spec.ts`、mesh-diagnostic 3 人矩陣連續 5 次全 =1。
- [ ] V6 單元全綠：`npm run test:run`（基線 124 檔／1421 tests）。
- [ ] V7 收尾文件：`docs/CURRENT-STATUS.md`、`docs/THREAT_MODEL.md`（Q4 口徑）、`docs/QA-REPORT-chat.md` 已知限制、mesh-correctness skill 殘留清單第 4 項改寫（現行描述已過時）、ADR 回填（Q5、必要時 GX3）。

## 7. 一致性自查（analyze，implement 前跑一次）

- [ ] 第 4 節方案覆蓋第 1 節六個缺口（含每個缺口的攻擊面），無多做
- [ ] 第 5 節任務完整實現第 4 節，無遺漏
- [ ] 第 6 節驗收能證明第 1 節，不是只證明「程式跑得動」
- [ ] 未違反憲法任何一條（特別是不變量聲明；Q3/Q6 若觸發 protocol 軌，加嚴條款已滿足）
- [ ] 硬邊界複查：diff 未觸及 SecurityManager 簽章覆蓋範圍與 SenderKeyManager seq 重放檢查
