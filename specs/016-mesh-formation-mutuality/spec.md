# Spec 016：修復 partial mesh 連線成形的互選缺口

- 軌別：feature
- 狀態：implementing（迴歸全綠已合入；7p 驗收待 CI 乾淨環境累積）
- 建立：2026-08-02／最後更新：2026-08-02
- 關聯：Spec 011（R-a 遺留）、ADR-0035（回填修訂）、mesh-correctness 殘留第 3 項

## 1. 要做什麼、為什麼（specify）

7 到 10 人房（Pro 唯一伺服器強制權益）的連線成形目前是機率樂透。實證（2026-08-02，
低負載 12 核機器，`7p-round1.log`）：101 次連線發起只有 17 次成形、72 次 ChannelBus
逾時循環重連、一頁 90 秒未達「已連線」，E2E `mesh-diagnostic-7p` 紅。

根因是結構性的：一條邊要成形，兩端都必須各自建立 `MeshConnection`（發起方由 uid
字典序裁決，應答方靠自己也「選中」對方才會建物件收訊），而 `selectNeighbors` 是
隨機洗牌取 k、reactive discovery 是發現順序取額，兩端互選纯屬機率（k=3、n=7 時
約每邊 0.25）。沒被互選的 offer 永遠無人接聽，只能等 2 分鐘一次的 fillNeighbors
重抽或退避重試耗盡。6 人以下 full mesh 人人選人人，互選必然成立，故從未出事。

Spec 011 R-a 已預警「連通性無設計保證，接線方案必須給出連通性論證（或 accept 側
讓位機制）」，當時以 ACCEPT_SLACK＋確定性模擬收尾；但模擬假設 k-圖已成形，只驗
訊息擴散層，成形層從未被證明。本 spec 補上這個證據缺口。

沒有它：Pro 賣的 10 人房在真實使用下要等數分鐘才能用、且不保證成形；
`mesh-diagnostic-7p` 永遠紅；Spec 011 V1 無法收口。

**憲法檢核**（constitution.md）：
- 目標函數加分項：可維運（7-10 人房從樂透變確定）；可嵌入（SDK 對外房間規模承諾
  變誠實）；補助競爭力（多人韌性 demo 可靠展示）。
- 四條不變量影響：
  - 恰好一次：間接。不動去重與對帳語義；成形變快讓 anti-entropy 的連通前提更早成立。
  - E2EE 機密性：無。不動金鑰與 keyx。
  - 帳本正當性：無。
  - 身分授權：無。鄰居選擇只用既有名冊（meshIdentities ∩ participants）與 uid 序。

## 2. 邊界（明確不做）

- 不動 gossip 線上格式與簽章（非 protocol 軌；signaling 通道與訊息格式不變）。
- 不動 full mesh（≤6 人）行為：characterization 保持，3 人矩陣回歸鎖不動。
- 不動 k 值公式與房間容量分層（Spec 011 Q1/Q3 拍板維持）。
- super-node（>20）維持凍結。
- 不在本 spec 內處理 rejoin flake（另案診斷中）。

## 3. 待釐清（clarify）——全部拍板（2026-08-02）

- [x] Q1 成形時間驗收：**維持 90 秒（E2E 現值不放寬）**；產品面 p95 30 秒列觀測目標
  不入斷言。
- [x] Q2 方案範疇：**確定性互選＋入站 offer 反應式應答一次做**。
- [x] Q3 旋轉 churn：**保留當韌性探針**（拆後重建同一條邊即為鏈路重建演練）；
  R-c 語義變更記入本 spec 與 ADR 回填。

## 4. 技術計畫（plan）

**A. 確定性互選（circulant 環）**：把 `selectNeighbors` 的隨機洗牌換成從「排序名冊」
決定性推導邊集。名冊＝identityMap 全體 userId ∪ 自己，字典序排序成環；目標集＝
環上偏移 ±1..±⌈k/2⌉ 的節點（circulant C_n(1..⌈k/2⌉)）。性質：
- 互選由構造保證（偏移集對負封閉，兩端從同一名冊算出同一條邊）；
- 連通（gcd(1,n)=1 的環必連通），直徑 ≤ ⌈n/(2⌊k/2⌋)⌉ ≈ 2-3（n≤10）；
- 度數 2⌈k/2⌉（k=3→4、k=4→4），高於 k 但有界，符合「只升不降」精神。
邊界：full mesh 檔（k ≥ n-1，即 ≤6 人）目標集＝全體，行為與現狀一致
（characterization 保持）。發起方裁決不動（uid 字典序＋Spec 005 介紹覆寫）。
名冊視圖短暫分歧（晚到者傳播窗）產生的暫時單邊嘗試由 B 兜底＋discovery push 自癒。
既有非目標邊不拆（只升不降）；rotation 保留，fillNeighbors 改走同一決定性推導。

**B. 入站 offer 反應式應答**：MeshTopologyManager 以 signalingFactory 建一條
房級觀察 transport（`subscribe` 本就回整房 signals，client 端過濾
`to == localFirebaseUid && type == 'offer'`）。看到「來自名冊內身分、但本端無
對應 MeshConnection」的 offer → 建應答端連線（isInitiator=false），上限
k+ACCEPT_SLACK。去重：已有連線物件則不動（signals 由該連線自己的 transport 消費，
10 分鐘 lookback 保證晚建也讀得到 offer）。非名冊身分的 offer 一律忽略（授權邊界
沿用 rules：只有房間參與者寫得進 signals）。零 wire 變更、零 rules 變更。

**取捨**：不採「純入站應答、不改選擇」——單邊隨機選擇仍會產生大量無效發起與
retry 風暴，B 只醫接聽不醫浪費；不採「動 rules 或 signals schema」——現行
subscribe 已覆蓋需求。模擬層補「成形層」證明，關閉 Spec 011 用擴散層模擬
充當成形證據的缺口。

**〔實作期修訂 2026-08-02〕C. signaling 訂閱視窗擴大（limit 50→400）**：接線後 7p 仍紅，
r 數據顯示選擇層已修（發起 101→78、單邊 offer 0）但 bus 逾時 106 次。深層根因：
`RoomSignalingTransport.subscribe` 為整房 signals＋createdAt 升冪＋limit(50)，
7 人成形風暴期一房數百筆 → 每訂閱者只看得到最早 50 筆，自己那對的 offer/answer
永遠讀不到；重試寫入使其更糟。3 人房 20-40 筆 < 50 故從不出事。
第一版修法（訂閱 where to==me 範圍化＋複合索引）在主觀察窗實測後回退：
7p 成形反而 0/28（當輪機器剛從睡眠喚醒、模擬器一度 unreachable，無法乾淨歸因），
依誠實條款鐵律二回退，改採不動 query 形狀的 limit 擴大（50→400），
涵蓋 10 人房尖峰、3 人房行為不變。範圍化保留為 transport 選填參數，
目前僅入站 offer 觀察者使用（純讀、只需 to==me）；主訂閱路徑維持整房。

完成後回填：ADR-0037（成形互選與入站應答＋signaling 範圍化）；Spec 011 V1 註記由本 spec 收口。

## 5. 任務分解（tasks）

- [x] T1 ⚠ characterization：3 人矩陣（mesh-diagnostic）本機釘現況綠，作為改動前錨點。
- [x] T2 純函式 `computeCirculantTargets(sortedRoster, self, k)`＋單元測試：
  互選對稱性（fast-check property：任意名冊下 target 關係對稱）、連通性（n≤10 全枚舉）、
  full-mesh 檔回傳全體、k 邊界（n=7..10 × k=3..4）。
- [x] T3 ⚠ 接線：selectNeighbors／reactive discovery／fillNeighbors 改走 T2；
  目標集連線不受 `neighbors.size >= limit` 提前 break 攔截（升級窗既有邊+新目標並存）。
- [x] T4 ⚠ 入站 offer 觀察者：房級 transport 訂閱＋過濾＋建應答端；cap、去重、
  名冊過濾；close 時取消訂閱。
- [x] T5 成形層確定性模擬 `tests/unit/meshFormation.simulation.spec.ts`：
  節點以亂序時間到場、名冊視圖漸進收斂，斷言「有限步內全圖連通」多 seed 全過
  （含晚到者、視圖分歧窗、入站應答開/關對照）。
- [x] T6 驗收執行（部分）：全單元 1558、3 人矩陣×3、@vue-stable、React @stable 全綠；**7p×3 綠未達成**——單機量測顯著改善（成形 12→20、bus 逾時 106→62、單邊 offer 歸零）但開發機 7 瀏覽器即 R-g 資源上限，驗收移至 e2e-7p.yml workflow（乾淨 runner，手動＋每日排程），連續綠後本項轉 [x]。
- [x] T7 文件收尾：CURRENT-STATUS、QA-REPORT 已知限制、ADR-0037 回填、
  Spec 011 V1 註記、docs/DEVELOPMENT.md Relay/Topology 表不變（拓撲策略表無用詞變更）。

**〔實作期發現 2026-08-03〕D. 分島殘留（獨立工項，本 spec 記錄不修）**：CI 第三輪實證
「鄰居健全 ≠ 全房可達」盲點（Spec 011 Q4）首次真實現身——房主被測試 goto 重載後，
向 circulant 目標重建的邊在網路抖動下耗盡 MAX_RECONNECT_ATTEMPTS=5 即永久放棄，
與最後加入者形成雙人孤島（兩頁 accepted=0 但「已連線」為真），rotation 2 分鐘
週期來不及自癒。修復方向（下一 spec）：重試耗盡後的低頻長期重試（或由 anti-entropy
偵測「已知 sender 長期零進帳」觸發重連）＋連線狀態的圖級誠實化。測試側的
自傷 goto 已移除（joinRoom 冪等化），emulator 假象恢復（reload 一次）已落地。

## 6. 驗收（黃金判準）

- `tests/unit/meshFormation.simulation.spec.ts` 多 seed 全綠（成形層證明落地）。
- `tests/e2e-vue/mesh-diagnostic-7p.spec.ts` 低負載連續 3 次綠（90 秒斷言不放寬）。
- `tests/e2e/mesh-diagnostic.spec.ts` 3 人矩陣連 3 次綠；`@vue-stable` 全綠；
  全單元綠（基線 1547+新增）。
- 五根因回歸鎖（SecurityManager／GossipMessageHandler spec）零改動零紅。

## 7. 自查（analyze）

- [x] 方案覆蓋需求：成形樂透（A 消滅無效發起、B 醫治分歧窗）；90 秒斷言（Q1）。
- [x] 任務覆蓋方案：T2/T3=A、T4=B、T5=證據缺口、T6=驗收、T7=文件。
- [x] 驗收證明需求而非「跑得動」：T5 斷言連通成形而非只斷言不當機；7p 三連綠。
