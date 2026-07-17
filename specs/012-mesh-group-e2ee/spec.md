# Spec 012：收斂 mesh 群組 E2EE 第二階段——關明文窗、堵盲信使明文外洩、立每通道安全分級

- 軌別：feature（起手）。若 clarify 拍板含「信使拒收明文的協議規則」（Q3-b/c）或「transport adapter 安全標籤契約」（Q6），該部分屬跨實作互通層，plan 階段須依 `templates/protocol-spec-template.md` 補齊格式定義與 conformance 測試向量。
- 狀態：clarifying
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

## 3. 待釐清（clarify，逐條由使用者拍板；全部清空才進 plan）

- [ ] **Q1 React 產線的處置範圍**（缺口三）：React 受 ADR-0017 凍結、Vue 切換觀察期至 2026-07-30。選項：
  - (a) 僅止血：React mesh 橋接／備援改「有金鑰才密文送、無金鑰不送」（對齊 Vue 語義，core API 已備妥 `encryptForFallback`），指示器文案同步修正；不補 plaintext 態與阻斷確認。
  - (b) 完整 parity：止血＋三態指示器＋阻斷確認（R2 已知邊界一併關閉）。
  - (c) 不動 React：接受明文洩漏至切換日，文件記錄。
  - 影響：(c) 意味 production 使用者的 mesh 訊息在覆蓋不足時持續明文入 Firestore。
- [ ] **Q2 exchanging 明文窗策略**（缺口一）：
  - (a) 送出閘：金鑰未就緒時 chat/game/reaction/read 通道不送（訊息標記待送，keyx 就緒後自動送出），比照 ADR-0004 星型「金鑰未就緒等待、不得默默降級明文」語義。子題：需配超時轉真降級——'exchanging' 逾時（如 30-60 秒）仍未就緒即轉入 fail-visible 流程（視同 plaintext 房，阻斷式確認後才可明文送），否則不發 ecdh 的成員可把房間變成永久拒送（DoS）。
  - (b) fail-visible 擴大：exchanging 也走阻斷式確認（每次或首次），不擋自動化路徑。
  - (c) 現狀接受：明文窗記入威脅模型與 UI 說明，不改行為。
  - 拍板重點：明文窗是「絕不明文出手」（a）還是「知情同意即可」（b）。(a) 動運作中送出路徑，風險最高但語義最乾淨。
- [ ] **Q3 盲信使明文過濾的位置與規則**（缺口二）：
  - (a) 推送側過濾：`runCourierBackup`／deposit 側跳過非密文紀錄（channel-aware：keyx 放行、其餘須 `nrec1` 信封）。
  - (b) 收側驗證：CourierServer/CourierStore 拒收非密文紀錄（同樣 channel-aware），拒收理由入 DepositResult。
  - (c) 兩側都做：推送側是洩漏的實際關口（必須），收側是防禦縱深＋協議承諾（「盲信使只存密文」成為可驗證的協議規則）。
  - 連動：(b)/(c) 改變寄存協議接受面 → protocol 軌加嚴（conformance 向量）＋ Spec 003 相容聲明。另須拍板：被過濾的明文紀錄的補齊路徑聲明（僅成員間 anti-entropy，信使不代管——寫進文件即可，或要 UI 提示）。
- [ ] **Q4 房間金鑰輪替節奏與前向保密口徑**（缺口四）：
  - (a) 維持現狀：僅名冊變動輪替；把「keyx 永存日誌、在籍成員可解全部歷史、無對在籍者的前向保密」明文寫進威脅模型與 README 安全節（誠實條款）。
  - (b) 加週期輪替（時間或訊息數）：縮小單一金鑰本體外洩的暴露面；代價是 keyx 紀錄線性增長、金鑰環變大、且如 1.2 所析**不提供**對在籍成員的前向保密（不得在文件上宣稱）。
  - (c) 真前向保密（ratchet＋刪舊鑰）：與補歷史產品語義正面衝突，需要「歷史可解性」的產品級重新定義；傾向排除，列出供否決。
  - 建議拍板順序：先決定威脅模型口徑（防什麼），再決定機制。
- [ ] **Q5 TreeKEM 與 GroupKeyManager 的處置**（缺口五，ADR-0031 續篇）：
  - (a) 退役：兩者移出（或隔離到 attic），26＋20 個測試隨遷；理由是與 live 世界觀（亂序 gossip、keyx-as-record）不合、keyx O(N) 到 20 人尺度都夠用。
  - (b) 續眠：留待 6+ 人拓撲實測（殘留 3）與 50+ 人需求出現再議；維持 ADR-0031 的「不動」現狀，本 spec 只補上懸置的分析結論。
  - (c) 採用 TreeKEM 作為金鑰分發 v2：傾向排除（有序送達假設與 gossip 相悖，需大改），列出供否決。
  - 完成後回填 ADR。
- [ ] **Q6 GX3 安全標籤模型的交付深度**（缺口六）：
  - (a) 型別契約：transport adapter 的安全等級宣告型別（e2ee／sign-only／plaintext）＋通道→標籤的判定函數；`EncryptionState` 改由標籤推導（房級狀態成為衍生值）。零行為變更。
  - (b) (a)＋最低等級閘門：應用（SDK 使用者）可宣告資料流最低安全等級，路由原語拒送低於宣告等級的通道；Nerilo 聊天預設宣告 e2ee（與 Q2 的送出閘同一原語收斂）。
  - (c) (b)＋UI 每通道標示（訊息或房間層顯示實際走的通道等級）。
  - 拍板重點：M4 平台抽取前最少需要 (a)；(b) 是 ADR-0010 Decision 2 的完整語義；(c) 是 GP2 誠實原則的 UI 面。
- [ ] **Q7 「密文出口一致」的驗收面**：驗收要斷言到哪些出口的位元組——(i) IndexedDB 複本（已有 mesh-e2ee.spec 先例）、(ii) Firestore 訊息文件（橋接／備援）、(iii) 信使 CourierStore 內容、(iv) exchanging 窗行為專項。全選或子集，決定第 6 節 V 條款的最終形狀與 E2E 成本。

## 4. 技術計畫（plan）

〔clarify 未清空，不進 plan。填寫時須：per-缺口列出動到的模組與檔案；Q3 若含收側驗證、Q6 若含 adapter 契約，依 protocol-spec-template 補齊格式與 conformance 向量；聲明對 Spec 003（信使寄存）與 Spec 009（session epoch，同期在動 GossipMessageHandler）的相容與合併順序；重大取捨完成後回填 ADR（至少：ADR-0031 續篇 TreeKEM 處置、GX3 標籤契約若定形亦應落 ADR）。影響面預估：GossipMessageHandler、encryptionGate、CourierService/CourierStore、ChatPage.tsx（React，依 Q1）、chat/[roomId].vue、types（EncryptionState 泛化）、docs/THREAT_MODEL.md。〕

## 5. 任務分解（tasks）

〔plan 定案後填。預告：GossipMessageHandler 送出路徑（Q2）與 React ChatPage（Q1）皆為運作中路徑，相關任務一律標 ⚠ 並走 harden-tests（characterization-first、分層閘門、誠實條款）；core 是 React／Vue 兩線共用，兩邊 E2E 皆不可破。〕

- [ ] T1：
- [ ] T2：

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
