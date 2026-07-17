# Spec 011：接入 6 人以上拓撲，解除 5 人房間上限

- 軌別：feature（現階段不改 gossip 線上格式與簽章覆蓋範圍；若 clarify／plan 拍板引入 wire 變更——例如覆蓋率回報或 digest 分頁——protocol 軌加嚴條款屆時適用，spec 須升軌補齊線上格式與 conformance 向量）
- 狀態：clarifying
- 建立：2026-07-18／最後更新：2026-07-18
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

## 3. 待釐清（clarify，逐條由使用者拍板；全部清空才進 plan）

- [ ] **Q1 目標人數上限與範疇**（決定整個 spec 的大小）：
  - (a) 上限 6：按現行程式仍是 full mesh（≤6），只是把 full mesh 從 5 人實測推到 6 人。改動最小，但 partial mesh 依然未實測，殘留第 3 項只算解決一半（甚至名不符實）。
  - (b) 上限 8-10：跨過 partial mesh 邊界（第 7 人起 k=3），真正行使多跳擴散、旋轉 churn 與自適應切換；E2E 規模尚在可實測範圍。super-node 維持凍結。
  - (c) 上限 20：吃滿 partial mesh 設計區間。E2E 無法全規模驗證（20 個瀏覽器 context），必須接受「E2E 驗小規模＋模擬驗大規模」的分層證據。
  - (d) 上限 >20：super-node 入範疇。選舉自報分數的信任問題（1.3 例外）與樞紐節點的隱私面（super-node 看得到誰跟誰通訊的元資料）都要正面處理，規模最大。
- [ ] **Q2 full-mesh 與 partial-mesh 的切換邊界**：程式（≤6 full mesh）與 CLAUDE.md 文件（3-5 full mesh、6-20 partial）不一致，接線前必須拍板一個並修正另一個：
  - (a) 依程式：6 人仍 full mesh（15 pairs，WebRTC 尚可行；ADR-0003 自己寫「超過 5 至 6 人即不可行」）。partial 從 7 人起。
  - (b) 依文件：6 人即 partial mesh。切換點提早，6 人房就開始行使多跳與 churn；full mesh 的實測負擔止於 5 人（現有基線）。
- [ ] **Q3 會話中人數跨界時的拓撲行為**（R-c 的政策面）：接線 `updateParticipantCount()` 後，房間人數在會話中跨過邊界（如 6→7 或 7→6）怎麼辦：
  - (a) 動態切換：照 AdaptiveTopologyManager 設計即時升降級。升級補連線、降級靠旋轉慢慢收——但「切換瞬間」是新的遷移窗類風險，且降級語義（shouldDowngrade 有程式、無呼叫者）從未行使。
  - (b) 進房定型：拓撲在 join 時按當下人數定死，會話中不切換；人數變化只影響新會話。犧牲自適應性換掉一整類時序風險，但「開 5 人房後陸續加到 8 人」會停留在錯誤拓撲。
  - (c) 只升不降：人數上升即升級（風險窗小、有 anti-entropy 兜底），下降不降級（多餘連線無正確性代價，只是資源）。
  - 另須拍板：參與人數的權威來源（房間文件 participants、meshIdentities 名冊、或兩者交集——與 keyx 的 rosterFromRoom 語義對齊與否）。
- [ ] **Q4 備援橋接條件在 partial mesh 下的語義**（R-d，成本與定位的產品決策）：
  - (a) 維持現狀（connected < n-1 即橋接）：partial mesh 下每訊息都寫 Firestore（密文）。送達性最保守，但 Firestore 寫入成本 O(每訊息)，且「P2P 為主、Firestore 備援」的敘事實質倒置。
  - (b) 條件改為 connected < k（目標鄰居數）：鄰居健全即信任 gossip 擴散＋對帳，橋接只在自身連線劣化時觸發。成本回歸例外路徑，但「鄰居健全≠全房可達」（R-a 分裂情境橋接不會觸發）。
  - (c) partial mesh 房停用每訊息橋接，改為週期性「水位／缺口」偵測後補：實作最複雜，證據最誠實。
  - (d) 依 mesh 覆蓋率的混合條件（如 connected/k 加上最近對帳成功時間）。
  - 拍板重點：多人房願意付多少 Firestore 成本換送達保守度；此決策直接影響帳本計量面（1.3）。
- [ ] **Q5 UI 連線狀態與就緒語義**：現行 UI 以「connected/(n-1)」呈現與判斷就緒。partial mesh 下 n-1 永遠達不到：
  - (a) 顯示 connected/k（目標鄰居數）：誠實反映拓撲設計，但使用者看到「3/3 已連線」不知道另外 4 人是否可達。
  - (b) 顯示「可達成員數」（經 gossip 心跳／對帳推導）：資訊最有用，但需要新的可達性推導（可能超出 feature 軌）。
  - (c) 淡化數字，只顯示健康狀態燈（健全／部分／斷線）：實作最小，資訊最少。
- [ ] **Q6 驗收規模與 E2E 基準**（R-g）：「實測接入」的證據標準：
  - (a) E2E 全規模：矩陣測到 Q1 拍板的上限人數，連續 5 次全 =1（沿用 3 人矩陣的口徑）。證據最強，CI 成本最高，>8 人恐不可行。
  - (b) 分層證據：E2E 實測到最小 partial mesh 規模（7 或 8 人，含跨界切換劇本），更大規模交給確定性模擬（antiEntropy.simulation 擴 partial mesh 隨機圖＋churn），另加一次手動真實裝置煙霧測試留紀錄。
  - (c) E2E 僅守 3 人現況，6+ 全靠模擬：不符「實測接入」的字面意義，列出供否決。
  - 另須拍板：連續通過次數與矩陣口徑是否沿用「連續 5 次全 =1」。
- [ ] **Q7 人數上限的產品分層**（商業決策，影響 RoomService 與 firestore.rules 的寫法）：
  - (a) 全員解鎖新上限：最簡單，但放棄 Pro 唯一可強制的權益落點（CROSS-MACHINE-HANDOFF:161-164、ADR-0003 預留的分層）。
  - (b) Free 維持 5、Pro 開到新上限：rules 以 `request.auth.token.plan` 分層強制（plan claim 管道已就緒）。Pro 權益第一次誠實兌現，但 rules 與 joinRoom 的分層邏輯要同步兩處。
  - (c) 先全員解鎖、分層另開 spec：把商業規則與拓撲正確性解耦，本 spec 只交付技術能力與單一新上限。

## 4. 技術計畫（plan）

〔clarify 未清空，不進 plan。填寫時影響面至少涵蓋：MeshGossipManager（updateParticipantCount 接線與人數來源）、MeshTopologyManager（accept 側連通性、旋轉政策）、AdaptiveTopologyManager（邊界修訂若 Q2 拍板 b）、GossipMessageHandler（多跳與 fanout 實測）、RoomService＋firestore.rules（上限與分層，兩處同值）、ChatPage.tsx 與 [roomId].vue（橋接條件與 UI 語義）、keyx（RoomKeyCoordinator 名冊規模）、CLAUDE.md 拓撲表與 ADR-0003/0007 狀態更新；重大取捨完成後回填 ADR。〕

## 5. 任務分解（tasks）

〔plan 定案後填。預告：MeshTopologyManager、GossipMessageHandler、RoomService、firestore.rules 皆為運作中路徑，相關任務一律標 ⚠ 並走 harden-tests（characterization-first、分層閘門、誠實條款）。〕

- [ ] T1：
- [ ] T2：

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
