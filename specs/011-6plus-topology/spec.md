# Spec 011：接入 6 人以上拓撲，解除 5 人房間上限

- 軌別：feature（clarify 拍板後確認不改 gossip 線上格式與簽章覆蓋範圍，維持 feature 軌）
- 狀態：implementing
- 建立：2026-07-18／最後更新：2026-07-18（clarify 全數拍板，進 plan／implement）
- 關聯：ADR-0003（分層拓撲既有決策：partial mesh／super-node「已有程式碼但未接入」）、ADR-0007（超過 5 人的拓撲列凍結類，「有真實需求再逐案解凍」——本 spec 即解凍案）、ADR-0008（付費層開放大房間的落點）、.claude/skills/mesh-correctness（殘留清單第 3 項）、docs/CROSS-MACHINE-HANDOFF.md:161-165（Pro 實質權益受「拓撲上限 5 人」限制）

## 1. 要做什麼、為什麼（specify）

目前房間人數上限 5 是產品層閘門（RoomService 與 firestore.rules 各寫死一份 5），不是 mesh 的技術極限實測結果：6-20 人 partial mesh（AdaptiveTopologyManager）與 20 人以上 super-node（SuperNodeElection）程式已寫、有單元測試，但從未接入產品流——關鍵接線點根本沒人呼叫（見 1.1）。本 spec 要把 6 人以上拓撲實測接入產品流：讓真實房間在超過 5 人時仍保持「訊息恰好一次」與 anti-entropy 收斂，並在驗證通過後解除（或分層放寬）人數上限。沒有它：多人場景（家族群、社群、災時協調）直接被擋在門外；Pro 分層唯一可伺服器端強制的權益（每房人數）無法誠實兌現（CROSS-MACHINE-HANDOFF:161-164）；ADR-0003 預留的「免費層 2-5 人、付費層大房間」商業落點懸空。

### 1.1 現況錨點（2026-07-18 逐檔核對）

- `src/core/mesh/AdaptiveTopologyManager.ts:37-42`：策略邊界 ≤2 direct、≤6 full-mesh、≤20 partial-mesh、>20 super-node。**注意與 CLAUDE.md 拓撲表（3-5 full mesh、6-20 partial mesh）不一致**：程式的 full-mesh 上界是 6，不是 5——「6 人房」按現行程式仍是 full mesh，partial mesh 從第 7 人才開始（Q2）。
- 同檔 :47-54：目標鄰居數 k——full mesh 為 n-1；partial mesh 為 max(3, ceil(sqrt(n)))（7 人=3、10 人=4、20 人=5）；super-node 一般節點 5。:59-70：gossip 參數分檔（≤6：fanout n-1／ttl 1；7-12：3／3；13-20：3／4；>20：4／5）。
- **關鍵斷線**：`src/core/mesh/MeshTopologyManager.ts:531-557` 的 `updateParticipantCount()` 是唯一會呼叫 `evaluateTopology()` 的產品入口，註解寫「由 MeshGossipManager 在參與者變動時呼叫」——但全 repo（src、web-vue、tests）無任何呼叫者。實際運行值恆為建構時預設：k=6、strategy='full-mesh'、gossipConfig={fanout:5, ttl:1}（:14-17）。AdaptiveTopologyManager 在產品流中是死碼，「自適應」從未發生。
- `src/core/mesh/SuperNodeElection.ts`：決定性選舉（分數降冪＋peerId 字典序 tiebreak，全員收斂同一結果），≤20 人回空集合；產品流無呼叫者（僅 RelayScorer 註解與 MetricsCollector 型別提及）。分數來源是節點**自報**的 uptime／bandwidth／latency／battery／NAT。
- 5 人上限真正所在：`src/services/RoomService.ts:337-343`（`MAX_PARTICIPANTS = 5`，joinRoom 交易內檢查）與 `firestore.rules:68-73`（`participantsWithinCap` ≤5，註解自陳「目前接線的拓撲上限是 5 人 full mesh；6 人以上的 partial mesh 未接線」）。兩處必須同值，rules 是伺服器端強制層。
- 產品流入口：Vue 聊天頁（`web-vue/app/pages/chat/[roomId].vue:371`，2 人房也一律走 gossip 複寫日誌）與 React ChatPage（2 人星型、3 人以上 mesh）最終都進 `MeshChatService → MeshGossipManager → MeshTopologyManager`。MeshGossipManager 初始化時建 MeshTopologyManager，此後**從不**告知參與人數變化。
- 轉發路徑存在且活著：`src/core/mesh/GossipMessageHandler.ts:382-386` 收訊後 ttl>0 即以 ttl-1 轉發（fanout 隨機選鄰）；但現行 ttl=1 → 轉發半徑一跳。5 人 full mesh 人人互鄰，一跳即全網；**多跳擴散從未在產品流被行使**。ttl 刻意不在簽章內（五根因修復之一），轉發遞減安全。
- anti-entropy：`MeshGossipManager.setupNeighborMessageHandlers()` 每 2 秒對所有已連上鄰居送 digest（per-sender floor/max/missing，`antiEntropy.ts`）；收斂論證前提是**鄰居圖連通**。防護參數：MAX_DIGEST_SENDERS=64、MAX_MISSING_PER_SENDER=100、MAX_FILL_PER_ROUND=200。
- 鄰居管理（`MeshTopologyManager`）：reactive discovery 與 connectToNeighbors 都以 `neighbors.size >= k` 為閘（:162、:181）——k 滿即不再接新 peer，且沒有為新 peer 讓位的 accept 機制；連線旋轉（:432-457）每 2 分鐘隨機拆一條再補，但只有 neighbors.size ≥ k 時才真的拆線——5 人房 k=6 永遠拆不到，churn 從未在產品流出現過。
- 覆蓋率／備援橋接假設 full mesh：`src/features/chat/ChatPage.tsx:483-484` 與 `web-vue/app/pages/chat/[roomId].vue:382-383` 的 `expectedPeers = participantCount - 1`，`coverage.connected < expectedPeers` 即寫 Firestore 加密備援。partial mesh 下「connected < n-1」是設計常態，此條件會讓**每一則訊息都觸發備援寫入**（Q4）。
- keyx（ADR-0023 P2-②c）：RoomKeyCoordinator 每 epoch 對全名冊成對 ECDH 封裝為單一 keyx 紀錄；名冊=meshIdentities ∩ participants。人數上升 → 紀錄變大、成員變動更頻繁 → epoch 輪替更頻繁。
- 既有測試：`tests/unit/AdaptiveTopologyManager.spec.ts`、`tests/unit/SuperNodeElection.spec.ts` 為純函式單元測試；`tests/unit/antiEntropy.simulation.spec.ts` 確定性模擬（雙節點／鏈狀圖）；E2E `tests/e2e/mesh-diagnostic.spec.ts` 為 3 人矩陣。**6 人以上沒有任何 E2E 或實測證據**。

### 1.2 6 人以上的正確性風險點（本 spec 要正面回答的）

- **R-a 連通性無設計保證**：partial mesh 的鄰居選擇是「發現順序＋隨機」（selectNeighbors 隨機洗牌、reactive discovery 先到先連），k 滿即拒新連線。晚到者若候選鄰居全數 k 滿，可能連不進圖；anti-entropy 收斂前提是連通圖，圖一旦分裂，兩岸各自一致但互不相通——**恰好一次沒破，但送達性破了**。接線方案必須給出連通性論證（或 accept 側讓位機制）。
- **R-b 多跳擴散首次上場**：拓撲真的切到 partial mesh 後 ttl>1，同一訊息多路徑多跳擴散，去重（inflight 預佔＋store）承受真實 WebRTC 時序的併發壓力；單元測過，產品流沒有。
- **R-c 旋轉 churn 首次上場**：k 滿後每 2 分鐘隨機拆一條活連線。拆線窗內的訊息靠對帳補（理論上收斂），但這是「遷移窗」同族的時序問題（殘留清單第 2 項），實測前無證據。
- **R-d 備援橋接語義崩壞**：現行 full-mesh 假設的橋接條件在 partial mesh 下每訊息必觸發，Firestore 寫入量、成本與「P2P 為主」的定位全面矛盾（Q4）。
- **R-e keyx 與名冊 O(n)**：keyx 紀錄大小、epoch 輪替頻率、遲到者需補多個 epoch 的窗口都隨人數放大；走同一條 gossip 管線故正確性同保證，但量變需實測。
- **R-f 防護參數觸界**：digest 上限（64 sender／100 missing）與 MAX_FILL_PER_ROUND=200 對 ≤20 人理論夠用，實測需確認不觸界（觸界只影響收斂速度，不影響收斂性——需以測試證明這句話在 6+ 人下仍真）。
- **R-g E2E 基礎設施成本**：3 人矩陣 ×5 連跑已是 CI 重負；6-8 個 Playwright context 的資源成本要先實測校準，驗收規模是取捨不是越大越好（Q6）。
- **R-h signaling 壓力**：6 人 full mesh=15 pairs；8 人 partial（k=3）約 12 條邊。Spec 005 warm 中繼降低 Firestore signaling 依賴，但 bootstrap 首波仍 cold。

### 1.3 憲法檢核（constitution.md）

- 目標函數加分項：補助競爭力（多人韌性通訊的 demo 規模與誠實可展示）；可嵌入（SDK 對外的房間規模承諾）；隱私韌性（更大房間仍不經伺服器明文——前提是 Q4 不把 partial mesh 變成「每訊息都走 Firestore」）。
- 四條不變量影響：
  - 恰好一次：**有**。多跳擴散＋旋轉 churn 下的去重與對帳是本 spec 的驗收主體（V1、V4、V5）。
  - E2EE 機密性：間接。不動金鑰演算法；keyx 名冊擴張與輪替頻率屬量變，遲到者補 epoch 窗口需實測（R-e）。
  - 點數帳本正當性：間接。備援橋接寫入量與信使寄存用量隨人數變化（Q4 拍板影響計量面）。
  - 身分與授權：現階段無（不動簽章與身分語義）。**例外**：若 Q1 把 super-node 納入範疇，選舉分數是節點自報值（可謊報 uptime／bandwidth 搶當樞紐），屬身分信任面的新攻擊面，範疇須在 plan 重新聲明。

## 2. 邊界（明確不做）

- 不動 gossip 簽章覆蓋範圍與線上格式——那是 Spec 009（session epoch）的領域；本 spec 與 009 的實作順序遵循 mesh-correctness skill 的優先序（009 先）。若 plan 階段發現需要 wire 變更，本 spec 升 protocol 軌再議。
- 不做殘留清單第 1 項（跨會話重放，Spec 009）、第 2 項（遷移窗可靠性）、第 4 項（mesh 群組 E2EE 第二階段）。實測若暴露 churn 掉信（R-c），記錄並轉交第 2 項，不在本 spec 內修。
- 預設不做 20 人以上 super-node 的實測接入（Q1 可翻案；翻案則 1.3 身分授權例外生效）。
- 不動 React 產線凍結與 Vue 切換節奏；core 與 RoomService 為兩線共用，實作階段兩邊皆不可破。UI 面的必要改動（Q5）以兩線共用層或 Vue 線為主，React 線只做不破壞性最小同步。
- 不動計費鏈路本身（Lemon Squeezy／webhook／plan claim 已就緒）；Q7 只決定人數權益的產品規則。
- 不解跨裝置備份、多副本合併（CURRENT-STATUS 既列的獨立優先項）。
- nuxt 釘 4.4.2，不升。

## 3. 待釐清（clarify——2026-07-18 使用者全數拍板，決議內嵌於各題）

- [x] **Q1 目標人數上限與範疇**（決定整個 spec 的大小）：**拍板 (b) 上限 10（8-10 檔位取上緣，一次到位）**；super-node 維持凍結。
  - 理由：跨過 partial mesh 邊界（第 7 人起 k=3）才真正行使多跳擴散、旋轉 churn 與自適應切換；E2E 尚可實測。上限取 10 是 8-10 檔位的上緣（plan 取捨：10 人時 k=4，多行使一檔 k 值；Pro 權益 5→10 也是誠實可說的差異）。
- [x] **Q2 full-mesh 與 partial-mesh 的切換邊界**：**拍板 (a) 依程式**——6 人仍 full mesh，partial 從第 7 人起；文件（CLAUDE.md Topology Strategy 表、README:19、docs/GOAL-ANALYSIS.md:164-165 的 3-5／6-20 表述）修正對齊程式。
- [x] **Q3 會話中人數跨界時的拓撲行為**：**拍板 (c) 只升不降**——人數上升即升級（有 anti-entropy 兜底），下降不降級（多餘連線無正確性代價）。人數權威來源：與 keyx 同語義，`rosterFromRoom(meshIdentities, participants).participantCount`（participants 集合大小；經 MeshGossipManager 既有的 directory watch push 通道取得）。
- [x] **Q4 備援橋接條件在 partial mesh 下的語義**：**拍板 (b) connected < k 才橋接**——鄰居健全即信任 gossip 擴散＋對帳；已知盲點「鄰居健全≠全房可達」由 V4 連通性模擬看住。實際條件為 `connected < min(n-1, k)`，使 ≤6 人房行為與現狀完全一致（characterization 保持）。
- [x] **Q5 UI 連線狀態與就緒語義**：**拍板 (a)+(c) 併用**——顯示 connected/k（目標鄰居數）＋健康狀態燈（健全／部分／斷線）。僅 web-vue 實作新 UI；React 線只做橋接條件的最小非破壞修正。
- [x] **Q6 驗收規模與 E2E 基準**：**拍板 (b) 分層證據**——E2E 實測到最小 partial mesh 規模（7 人，含跨 6→7 邊界的加入劇本）；更大規模交確定性模擬（partial mesh 隨機 k-圖＋churn＋晚到者，多 seed）；另加一次手動真實裝置煙霧測試留紀錄。矩陣口徑沿用「連續 5 次全 =1」。
- [x] **Q7 人數上限的產品分層**：**拍板 (b) Free 5、Pro 10**——房間容量屬房主權益：createRoom 時依房主 plan 寫入 `maxParticipants` 欄位（rules 以 `request.auth.token.plan` 驗證上限），join 一律對房間文件上的容量強制（加入者的方案不影響）；rules 與 joinRoom 兩處同語義。

## 4. 技術計畫（plan）

原則：**不動 GossipMessageHandler 本體**（它經 `topologyManager.getGossipConfig()` 讀動態參數，接線後自動取得 partial mesh 的 fanout/ttl，零改動）；**AdaptiveTopologyManager 門檻不改**（Q2a）；升級政策集中在 MeshTopologyManager 單點、單元可測。

### 4.1 拓撲引擎接線（Q1/Q2/Q3）

- `MeshTopologyManager.updateParticipantCount()` 改為「只升不降」政策：
  - 新策略 rank > 現行 → 整組採納（strategy、k、gossipConfig）。full→partial 時 k 由 6 縮到 max(3,⌈√n⌉) 是**設計內縮編**，既有多餘連線由旋轉逐步收斂（現有註解語義）；
  - rank 相同 → k 與 gossipConfig 只取 elementwise max（partial 區間內 7→10 人 k 3→4 單調不縮）；
  - rank 較低 → 忽略（不降級）。
  - 淨效果：≤6 人房永遠停在建構預設（k=6、fanout 5、ttl 1），**現有 2-5 人基線行為位元級不變**（characterization 保證）；第 7 人到場才首次切 partial。
- 接線點：`MeshGossipManager.initialize()` 既有的 `directory.watchIdentities` push callback（latestDirectorySnapshot 同源），以 `rosterFromRoom().participantCount` 呼叫 `updateParticipantCount()`（Q3 權威來源）。watch 不可用（測試樁/受限環境）→ 不更新，維持 full-mesh 預設（誠實降級，行為同今日）。
- **R-a accept 側讓位（accept-slack）**：reactive discovery 對「全新 candidate」的連線允許上限放寬為 k+2（`ACCEPT_SLACK=2`）；fillNeighbors／scheduleReconnect／rotation 維持嚴格 k。保證晚到者的 offer 一定有人接（雙側都會建 MeshConnection），超出部分由旋轉修剪。≤6 人房 k=6≥n-1，slack 永不觸發，行為不變。
- 取捨：政策放 MeshTopologyManager 而非 caller——單點、可單元測、caller 只餵事實（人數）；不做全域重平衡（超出 feature 軌且 10 人內無必要）。

### 4.2 覆蓋率透出與橋接條件（Q4/Q5）

- `MeshTopologyManager.getTargetNeighborCount()` → `MeshGossipManager.getConnectionState().targetNeighbors` → `MeshChatService.getMeshCoverage().targetNeighbors`（純新增欄位，舊欄位不動）。
- 橋接條件（兩線）：`expectedPeers = min(participantCount-1, targetNeighbors)`；targetNeighbors 缺失時退回 participantCount-1（＝現狀）。≤6 人房 min 取 n-1，行為不變。
- web-vue：連線指示改 connected/target ＋三態健康燈（healthy：connected≥target；partial：0<connected<target；down：0）。React 線僅改橋接條件一行（凍結政策）。

### 4.3 人數上限分層（Q7）

- `RoomService.createRoom` 新增選填 `maxParticipants`（int，夾在 2..10，預設 5）寫入房間文件；`joinRoom` 上限改讀 `roomData.maxParticipants ?? 5`（legacy 房無欄位＝5，不遷移）。
- `firestore.rules`：`participantsWithinCap` 改讀文件欄位（缺欄位＝5、硬上限 10）；create 時驗證欄位值——>5 需 `request.auth.token.plan == 'pro'`；update 時欄位不可變。容量屬**房主**權益，join 側不看加入者 plan。
- web-vue dashboard 建房時依房主 plan 傳 10（pro）／缺省（free）。React 不加建房新能力（凍結），join 大房不受影響（讀房間欄位）。

### 4.4 驗證（Q6）

- 單元：MeshTopologyManager 政策新測（只升不降、slack、target 透出）；MeshGossipManager 接線測；RoomService 容量測。
- 模擬：antiEntropy.simulation 擴 partial mesh 隨機 k-圖（n=7..10，出度 k=max(3,⌈√n⌉)）＋每輪旋轉 churn＋晚到者中途進場，多 seed 收斂斷言（V4/R-a）。
- E2E：新增 7 人矩陣 spec（含第 7 人跨界加入劇本），口徑沿用 =1；跑不動的環境限制如實記錄。
- 完成後回填 ADR-0033（partial mesh 接線與只升不降政策的取捨）。

## 5. 任務分解（tasks）

- [ ] T1 ⚠ characterization 基線：`npm run test:run` 全綠（124 檔／1421 tests）後才動手。
- [ ] T2 ⚠ MeshTopologyManager：只升不降政策、ACCEPT_SLACK、getTargetNeighborCount；新單元 `MeshTopologyManager.topology.spec.ts`。
- [ ] T3 MeshGossipManager：watch callback 接線 updateParticipantCount（rosterFromRoom 語義）；getConnectionState 透出 targetNeighbors；更新既有 mock。
- [ ] T4 MeshChatService.getMeshCoverage 加 targetNeighbors；web-vue 橋接條件＋connected/k＋健康燈；React ChatPage 橋接條件最小修。
- [ ] T5 ⚠ RoomService maxParticipants 分層＋firestore.rules 同語義修訂；RoomService 單元擴充。
- [ ] T6 模擬擴充：partial mesh k-圖＋churn＋晚到者多 seed（antiEntropy.simulation.spec.ts）。
- [ ] T7 E2E 7 人矩陣 spec（mesh-diagnostic-7p）；執行結果或環境限制如實記錄。
- [ ] T8 文件收尾：README、GOAL-ANALYSIS、firestore.rules 註解、CROSS-MACHINE-HANDOFF Pro 段、CURRENT-STATUS、ADR-0003/0007 狀態、ADR-0033 回填。

## 6. 驗收（黃金判準，沿用 mesh-correctness skill 四層驗收，缺一不可）

- [ ] V1 6+ 人 E2E 矩陣轉綠：規模與口徑依 Q1／Q6 拍板（含跨 full-mesh／partial-mesh 邊界的加入劇本、晚到者補齊劇本）；恰好一次 =1 斷言沿用 mesh-diagnostic 口徑。
- [ ] V2 既有回歸鎖不動搖：`mesh-diagnostic.spec.ts` 3 人矩陣連續 5 次全 =1；`GossipMessageHandler.spec.ts`、`SecurityManager.spec.ts` 五根因回歸鎖維持綠，不得放寬斷言湊綠。
- [ ] V3 單元全綠：`npm run test:run`（基線 124 檔／1421 tests）。
- [ ] V4 確定性模擬擴充：`antiEntropy.simulation.spec.ts` 增 partial mesh 隨機圖（k=max(3,ceil(sqrt(n)))）＋旋轉 churn 情境，多 seed 全過；含 R-a 連通性劇本（晚到者、k 滿讓位或其反例證明）。
- [ ] V5 橋接用量斷言：依 Q4 拍板的條件，partial mesh 房的 Firestore 備援寫入量有可執行測試證明其符合拍板語義（不是每訊息必寫，除非拍板 a）。
- [ ] V6 上限強制一致：RoomService 與 firestore.rules 的上限（含 Q7 分層）有測試證明兩處同值同語義（rules 以 emulator 測試覆蓋）。
- [ ] V7 收尾文件：`docs/CURRENT-STATUS.md`、`docs/QA-REPORT-chat.md` 已知限制清單、`docs/CROSS-MACHINE-HANDOFF.md:161-165` Pro 權益段、CLAUDE.md 拓撲表、firestore.rules 註解、ADR-0003／0007 狀態同步更新。

## 7. 一致性自查（analyze，implement 前跑一次）

- [ ] 第 4 節方案覆蓋第 1 節全部需求（含 1.2 全部風險點 R-a 至 R-h 的處置或明示接受），無多做
- [ ] 第 5 節任務完整實現第 4 節，無遺漏
- [ ] 第 6 節驗收能證明第 1 節，不是只證明「程式跑得動」
- [ ] 未違反憲法任何一條（特別是不變量聲明；Q1 若納 super-node，身分授權例外已重新聲明）
