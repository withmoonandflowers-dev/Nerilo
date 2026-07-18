# Spec 009：session epoch 入簽章，收斂跨會話重放

- 軌別：protocol（變更 gossip 簽章覆蓋範圍與線上格式，屬跨實作互通層；clarify 清空後，plan 階段須依 `templates/protocol-spec-template.md` 補齊線上格式、密碼學語義與 conformance 測試向量）
- 狀態：clarifying
- 建立：2026-07-18／最後更新：2026-07-18
- 關聯：ADR-0026（R1 處置：短期風險接受、排修 P1）、ADR-0023（P1 複本持久化，已落地）、風險登記 R1（docs/audit/core-invariants-risks.csv）、docs/QA-REPORT-chat.md 行 139-150、.claude/skills/mesh-correctness（殘留清單第 1 項）

## 1. 要做什麼、為什麼（specify）

mesh gossip 收訊路徑為了不誤殺 anti-entropy 補送，驗簽停用了時效窗（`maxAgeMs: null`）。代價是跨會話重放不再受任何時間限制：新會話 store 為空時，持有舊會話錄音的房內鄰居可以重放舊的合法已簽名訊息，讓舊內容重現、或預先佔用 (senderId, seq) 槽位。本 spec 要把「會話代」（session epoch）納入簽章與接受規則，使舊會話訊息在新會話中不再被當作現行訊息接受，同時不破壞 anti-entropy 補送這條已用回歸鎖釘住的根因修復。這是 mesh 正確性殘留清單中唯一的安全性缺口，也是核心不變量稽核「有條件通過」尚未閉環的 R1。

### 1.1 威脅模型

- 攻擊者條件：曾是房內成員或曾攔截線路，持有完整的舊會話已簽名 `GossipMessage`（含簽章的密文原文）。重放時需為房內已連上的鄰居。
- 受害者條件：store 缺該區間的節點。同裝置重載已由 ADR-0023 P1 緩解（store、floors、自身 seq 皆落盤 IndexedDB，reserve-then-send 保證自己的 seq 不重用）；剩餘攻擊面是新裝置、清除儲存、無痕視窗、以及剛加入的遲到者。持久層是可注入的 port（`IGossipPersistence | null`），記憶體模式行為同 P1 之前。
- 攻擊效果一：舊內容重現。收端 store 沒有該 (senderId, seq)，驗簽通過（簽章本來就是合法的）即入 store 上 UI。
- 攻擊效果二：預佔槽位。sender 換裝置後 seq 從頭起算（reserveSeq 是 per 裝置 IndexedDB），攻擊者先把舊會話低位 seq 重放進受害者 store，sender 之後真正的新訊息就被當「已處理過」丟棄。
- 不是破口的部分：簽章覆蓋 content，攻擊者無法偽造或竄改內容；未來時間戳超過 30 秒時鐘偏差一律拒絕，不受 `maxAgeMs` 影響。ADR-0026 判定此風險屬體驗與混淆層級，非機密性或完整性破口，故當時決策為短期接受、排修 P1；本 spec 即該 P1 修復。

### 1.2 現況錨點（2026-07-18 逐檔核對）

- `src/core/mesh/GossipMessageHandler.ts:322-330`：收訊驗簽傳 `maxAgeMs: null`，註解自我揭露理由（補送與首次洪泛在線路上無法區分，任何 wall-clock 門檻都會拒掉補給遲到者的舊訊息）；本路徑重放防護由 (senderId, seq) 同步去重、inflight 預佔與 floor 承擔。
- `src/core/mesh/SecurityManager.ts:60-91`：`verifyMessage` 預設 5 分鐘時效窗，呼叫端可傳 null 停用；未來時間戳逾 `MAX_CLOCK_SKEW_MS`（30 秒）一律拒絕。簽章覆蓋 roomId、senderId、pubKey、seq、timestamp、content、messageId（選）、channel（選）；ttl 是轉發時遞減的可變路由欄位，刻意排除（五根因之一的修復）。簽章覆蓋範圍的任何變更即為本 spec 所屬的協議變更。
- `src/core/crypto/SenderKeyManager.ts:326-342`：解密層另有 per-(senderId, senderKeyEpoch) 嚴格遞增 seq 的重放檢查。`senderKeyEpoch` 是金鑰輪替代（100 則或 1 小時輪替），與本 spec 的會話代是兩個概念；方案必須明確銜接或區隔，不可混用名詞。
- `src/core/p2p/HelloNegotiator.ts`：既有兩種版本協商語義可用：`protocolVersion` 取 min() 的靜默降級，與 `strictProtocols` 的版本必須相等、不等即提示（不靜默降級）。
- ADR-0026 已記錄兩個修復方向草案：store floor 跨會話持久化（不改 wire，但多裝置同步是硬題）與 session epoch 入 wire（本 spec 走向，實際擇定見第 3 節）。
- 回歸鎖（本 spec 不得破壞）：`tests/unit/GossipMessageHandler.spec.ts` 行 212 起「驗簽以 maxAgeMs: null 呼叫」、行 333 起「遲到者收到 30 分鐘前簽名的補送訊息：恰好一次呈現」；`tests/unit/SecurityManager.spec.ts` 時效窗可停用四例與 ttl 排除簽章；`tests/unit/antiEntropy.simulation.spec.ts` 多 seed 收斂。

### 1.3 憲法檢核（constitution.md）

- 目標函數加分項：隱私韌性（收斂目前唯一開放的安全性缺口）；可嵌入（SDK 對外承諾的正確性基礎）；補助競爭力（稽核報告 R1 閉環，安全敘事可對外）。
- 四條不變量影響：
  - 恰好一次：有。改動去重與驗簽核心，且明確受約束於「不得破壞 anti-entropy 補送」（見第 2 節與第 6 節 V2）。
  - E2EE 機密性：間接。只動簽章語義，不動金鑰流程；與 senderKeyEpoch 的關係須在 clarify 釐清（Q1 選項 c）。
  - 點數帳本正當性：間接。Protocol Spec 003 信使寄存的 `record` 就是已簽名 gossip 紀錄，wire 欄位變更會影響信使側驗章與補送相容（Q4）。
  - 身分與授權：有。簽章覆蓋範圍是身分驗證的核心語義。

## 2. 邊界（明確不做）

- 不做殘留清單第 2、3、4 項（遷移窗可靠性、6+ 人拓撲、mesh 群組 E2EE）；本 spec 只收斂跨會話重放。
- 不動 SenderKeyManager 的金鑰輪替與解密層 seq 檢查（除非 Q1 拍板採金鑰代綁定方案，屆時範圍在 plan 重新聲明）。
- 不改 anti-entropy 對帳演算法本體（pull-based、冪等、對稱差收斂的語義不變；digest 線上格式若因去重鍵變更而動，屬本 spec 影響面，須列入 plan）。
- 不解多裝置同身分的 seq、floor、epoch 同步（跨裝置備份與多副本合併是 CURRENT-STATUS 既列的獨立優先項）。
- 不動 React 產線凍結與 Vue 切換節奏；core 為兩線共用，實作階段兩邊皆不可破。

## 3. 待釐清（clarify，逐條由使用者拍板；全部清空才進 plan）

- [ ] **Q1 epoch 來源與權威**（互斥選項）：
  - (a) per-sender 自宣告會話代：每個 sender 在本裝置持久保留單調遞增 epoch（比照 `reserveSeq` 的 reserve-then-send），簽進自己的訊息；收端 per-sender 追蹤現行代。免協調，但新裝置或清儲存後 epoch 歸零，且「收端如何得知現行代」需配套（連動 Q2）。
  - (b) 房間層會話代：房間成員對「這是第幾次會話」有共同認知後推進。mesh 無固定權威節點，協調成本與拜占庭問題須評估。
  - (c) 綁 senderKeyEpoch：復用金鑰輪替代。免新欄位語義，但把金鑰輪替與會話語義耦合，且明文相容房（keyx 不可用時）沒有這個代。
  - (d) 時間桶 epoch：由 timestamp 粗粒度導出。免協調，但等於變相重新引入 wall-clock 門檻，與補送相容的矛盾回到原點；傾向排除，列出供否決。
- [ ] **Q2 舊 epoch 訊息的接受策略**（本 spec 的核心難題）：anti-entropy 補送在線路上與首次洪泛無法區分，而補送本來就是舊會話簽出的訊息；「舊 epoch 一律拒收」會直接殺死補送、違反回歸鎖。需拍板防護目標與對應策略：
  - (a) epoch 擴充去重鍵：store 鍵改 (senderId, epoch, seq)，舊 epoch 不拒收，只保證不同代之間不互相佔位。擋掉「預佔槽位」，但「舊內容重現」依然存在。
  - (b) 現行代門檻加補送豁免通道：直接洪泛只收 per-sender 現行 epoch；舊 epoch 只在 anti-entropy 對帳情境（拉方以 digest 明示請求）接受，「拉方主動請求」本身就是區分依據。兩種攻擊效果都擋，但把區分資訊放進對帳協議是更大的 wire 變更。
  - (c) 混合：(a) 為底、(b) 為加強。
  - 拍板重點：只擋預佔槽位（a 即足），或連舊內容重現一併擋（需 b 或 c）。
- [ ] **Q3 協議版本升級與舊版本節點相容**：epoch 欄位入簽章後，舊版節點驗章時的序列化不含該欄位，雜湊不合即拒收新版訊息；混版房間會分裂。選項：
  - (a) `protocolVersion` min() 協商：混版房降級為不帶 epoch（防護失效但互通），全員新版才啟用。要正視降級攻擊：攻擊者謊稱舊版即可剝掉防護，min() 語義正是靜默降級。
  - (b) `strictProtocols` 相等語義：版本不合即提示雙方更新，不靜默降級。防護不可剝，但犧牲混版互通。
  - (c) 雙簽過渡期：新版同時附含 epoch 與不含 epoch 兩份簽章，過渡期後移除舊簽。互通與防護兼得，換取線上體積與實作複雜度。
  - 另須拍板：版本訊號放在哪（HELLO 能力協商、GossipMessage 本體、或兩者），與舊版支援的退場時程。
- [ ] **Q4 既存資料遷移**：
  - IndexedDB 已落盤的舊格式紀錄（無 epoch）重載後如何處理：(a) 視為 legacy 代原樣保留、可繼續補送；(b) 一次性標記遷移；(c) 丟棄（違反恰好一次，列出供否決）。
  - Protocol Spec 003 信使寄存的 record 是已簽名 gossip 紀錄：舊格式欠條寄存的取回與補送，在新版收端是否仍被接受，接受到什麼時候。
- [ ] **Q5 去重鍵與 digest 影響面**：若 Q2 拍板含 (a)，antiEntropy digest 的 floor、max、missing 是否從 per-senderId 改為 per-(senderId, epoch)，floors 淘汰語義是否跟著分代。這決定 wire 變更的實際範圍。
- [ ] **Q6 「拒收」的驗收口徑**：ADR-0026 驗收寫「舊會話訊息注入新會話應被拒」；「拒」的定義是完全不入 store 不上 UI，還是可入 store 但標記為歷史補送、不當現行訊息呈現。這影響 V1 測試的斷言寫法。

## 4. 技術計畫（plan）

〔clarify 未清空，不進 plan。填寫時須：依 protocol-spec-template 補齊線上格式（逐欄位定義、版本欄位）、密碼學語義（簽章覆蓋欄位與序列化順序）、狀態機、錯誤與相容策略；重大取捨完成後回填 ADR；影響面至少涵蓋 GossipMessageHandler、SecurityManager、antiEntropy、GossipPersistence（Dexie schema）、HelloNegotiator、CourierService（Spec 003 record 相容）。〕

## 5. 任務分解（tasks）

〔plan 定案後填。預告：GossipMessageHandler 與 SecurityManager 皆為運作中路徑，相關任務一律標 ⚠ 並走 harden-tests（characterization-first、分層閘門、誠實條款）。〕

- [ ] T1：
- [ ] T2：

## 6. 驗收（黃金判準，沿用 mesh-correctness skill 四層驗收，缺一不可）

- [ ] V1 重放專項轉綠：舊會話錄下的合法已簽名訊息注入新會話，依 Q6 拍板的口徑被拒（ADR-0026 驗收條款）；含「預佔槽位」劇本（重放後 sender 新訊息不得被誤判重複）。
- [ ] V2 補送回歸鎖不動搖：`GossipMessageHandler.spec.ts` 的 30 分鐘舊訊息補送整合測試與 `maxAgeMs: null` 案例、`SecurityManager.spec.ts` 時效窗與 ttl 案例維持綠，不得以放寬斷言湊綠。
- [ ] V3 單元全綠：`npm run test:run`（基線 124 檔／1421 tests）。
- [ ] V4 確定性模擬：`tests/unit/antiEntropy.simulation.spec.ts` 多 seed 全過。
- [ ] V5 E2E 診斷：`tests/e2e/mesh-diagnostic.spec.ts` 3 人矩陣連續 5 次全 =1（`npm run test:e2e:ci`，需 Java 21+）。
- [ ] V6 protocol 軌 conformance：測試向量落地（給定舊會話重放輸入必須拒收、給定補送輸入必須接受），他人實作可執行。
- [ ] V7 收尾文件：`docs/CURRENT-STATUS.md`、`docs/QA-REPORT-chat.md` 已知限制清單、`docs/audit/core-invariants-risks.csv` R1 狀態同步更新。

## 7. 一致性自查（analyze，implement 前跑一次）

- [ ] 第 4 節方案覆蓋第 1 節全部需求（含威脅模型兩種攻擊效果），無多做
- [ ] 第 5 節任務完整實現第 4 節，無遺漏
- [ ] 第 6 節驗收能證明第 1 節，不是只證明「程式跑得動」
- [ ] 未違反憲法任何一條（特別是不變量聲明與 protocol 軌加嚴條款）
