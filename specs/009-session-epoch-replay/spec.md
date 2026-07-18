# Spec 009：session epoch 入簽章，收斂跨會話重放

- 軌別：protocol（變更 gossip 簽章覆蓋範圍與線上格式，屬跨實作互通層；plan 依 `templates/protocol-spec-template.md` 補齊線上格式、密碼學語義與 conformance 測試向量）
- 狀態：planned（clarify 已由使用者全數拍板，見第 3 節）
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

## 3. 待釐清（clarify，已全數由使用者拍板，2026-07-18）

- [x] **Q1 epoch 來源與權威**（互斥選項）：
  - (a) per-sender 自宣告會話代：每個 sender 在本裝置持久保留單調遞增 epoch（比照 `reserveSeq` 的 reserve-then-send），簽進自己的訊息；收端 per-sender 追蹤現行代。免協調，但新裝置或清儲存後 epoch 歸零，且「收端如何得知現行代」需配套（連動 Q2）。
  - (b) 房間層會話代：房間成員對「這是第幾次會話」有共同認知後推進。mesh 無固定權威節點，協調成本與拜占庭問題須評估。
  - (c) 綁 senderKeyEpoch：復用金鑰輪替代。免新欄位語義，但把金鑰輪替與會話語義耦合，且明文相容房（keyx 不可用時）沒有這個代。
  - (d) 時間桶 epoch：由 timestamp 粗粒度導出。免協調，但等於變相重新引入 wall-clock 門檻，與補送相容的矛盾回到原點；傾向排除，列出供否決。
  - **拍板：(a)**。理由：mesh 無固定權威節點，(b) 的協調成本與拜占庭問題不成比例；(c) 把金鑰輪替與會話語義耦合且明文相容房無此代；(d) 重新引入 wall-clock 門檻，否決。「epoch 歸零」配套見 plan 4.4（配發規則取 max(持久下一值, Date.now())，清儲存後的新代在正常時鐘下必然高於舊代）。「收端如何得知現行代」＝收端 per-sender 追蹤已驗簽訊息中的最高代（單調採納），見 plan 4.5。
- [x] **Q2 舊 epoch 訊息的接受策略**（本 spec 的核心難題）：anti-entropy 補送在線路上與首次洪泛無法區分，而補送本來就是舊會話簽出的訊息；「舊 epoch 一律拒收」會直接殺死補送、違反回歸鎖。需拍板防護目標與對應策略：
  - (a) epoch 擴充去重鍵：store 鍵改 (senderId, epoch, seq)，舊 epoch 不拒收，只保證不同代之間不互相佔位。擋掉「預佔槽位」，但「舊內容重現」依然存在。
  - (b) 現行代門檻加補送豁免通道：直接洪泛只收 per-sender 現行 epoch；舊 epoch 只在 anti-entropy 對帳情境（拉方以 digest 明示請求）接受，「拉方主動請求」本身就是區分依據。兩種攻擊效果都擋，但把區分資訊放進對帳協議是更大的 wire 變更。
  - (c) 混合：(a) 為底、(b) 為加強。
  - 拍板重點：只擋預佔槽位（a 即足），或連舊內容重現一併擋（需 b 或 c）。
  - **拍板：現行代門檻（比列出的選項更嚴）**。直接洪泛與 anti-entropy 對帳一律只接受 per-sender 現行 epoch，不設補送豁免通道。使用者已知情並接受代價：新成員／新裝置補不到舊會話歷史，「跨會話補歷史」這個產品能力放棄。同會話（現行 epoch）內的 anti-entropy 補送必須完好——30 分鐘舊訊息補送回歸鎖絕對不可破，因為那些是現行 epoch 簽出的訊息（epoch 門檻不是 wall-clock 門檻，兩者正交）。
- [x] **Q3 協議版本升級與舊版本節點相容**：epoch 欄位入簽章後，舊版節點驗章時的序列化不含該欄位，雜湊不合即拒收新版訊息；混版房間會分裂。選項：
  - (a) `protocolVersion` min() 協商：混版房降級為不帶 epoch（防護失效但互通），全員新版才啟用。要正視降級攻擊：攻擊者謊稱舊版即可剝掉防護，min() 語義正是靜默降級。
  - (b) `strictProtocols` 相等語義：版本不合即提示雙方更新，不靜默降級。防護不可剝，但犧牲混版互通。
  - (c) 雙簽過渡期：新版同時附含 epoch 與不含 epoch 兩份簽章，過渡期後移除舊簽。互通與防護兼得，換取線上體積與實作複雜度。
  - 另須拍板：版本訊號放在哪（HELLO 能力協商、GossipMessage 本體、或兩者），與舊版支援的退場時程。
  - **拍板：(b) strictProtocols 相等語義**。版本不合即提示雙方更新，不靜默降級（min() 語義即降級攻擊面，否決 (a)；(c) 雙簽的線上體積與複雜度不值）。版本訊號放 HELLO 能力協商；mesh 連線目前沒有 HELLO 交換，plan 4.7 定義 mesh 側的等價機制（GOSSIP_HELLO）與「無訊號＝舊版」的判定。舊版無退場過渡期：v2 上線即 v1 不互通（fail-visible 提示，不 fail-silent 分裂）。
- [x] **Q4 既存資料遷移**：
  - IndexedDB 已落盤的舊格式紀錄（無 epoch）重載後如何處理：(a) 視為 legacy 代原樣保留、可繼續補送；(b) 一次性標記遷移；(c) 丟棄（違反恰好一次，列出供否決）。
  - Protocol Spec 003 信使寄存的 record 是已簽名 gossip 紀錄：舊格式欠條寄存的取回與補送，在新版收端是否仍被接受，接受到什麼時候。
  - **拍板：(b) 一次性標記遷移**。重載時批次遷移為帶 epoch 的新格式（legacy 標記 sessionEpoch=0），遷移須可中斷恢復（plan 4.8 用 IndexedDB versionchange 交易的原子性保證）。誠實處理：舊紀錄無法重簽（簽章不覆蓋 epoch），故 legacy 紀錄只供本機呈現、不可再對外補送——與 Q2 一致（收端本來就會拒收非現行代）；聊天顯示歷史存於應用層 chatStorage（IndexedDBService），不受影響。信使寄存的舊格式 record 比照辦理：v2 收端一律拒收（形狀檢查缺 sessionEpoch 即拒），無豁免、無過渡期；信使側資料靠 byte-day 計價與墓碑自然退場，不另做清理程式。
- [x] **Q5 去重鍵與 digest 影響面**：**拍板：(a) 全面分代**。訊息身分／去重鍵改 (senderId, sessionEpoch, seq)；antiEntropy digest 的 floor/max/missing 改 per-(senderId, epoch)，floors 淘汰語義跟著分代。配合 Q2 現行代門檻，digest 每個 sender 只宣告現行代持有（宣告舊代是徒勞——對方必拒），詳 plan 4.6。
- [x] **Q6 「拒收」的驗收口徑**：**拍板：(a) 一律完全拒收**。舊 epoch 訊息不入 store、不上 UI、不轉發、不觸發任何監聽器；V1 斷言照此寫。

## 4. 技術計畫（plan，依 protocol-spec-template）

重大取捨回填於 ADR-0033（docs/adr/0033-session-epoch-replay-closure.md）。

### 4.1 目的與範圍

把 per-sender 會話代（session epoch）納入 gossip 簽章與接受規則：舊會話簽出的訊息在收端已知現行代後不再被接受，且「預佔槽位」在任何情況下都不可能（去重鍵分代）。不規範：epoch 的 UI 呈現、多裝置同身分的 epoch 同步（既列獨立項）、SenderKeyManager 金鑰輪替（senderKeyEpoch 是另一個代，本協議不碰）。

### 4.2 術語

- **sessionEpoch（會話代）**：sender 每次進房會話配發一次的整數，本裝置持久單調遞增，簽進該會話所有訊息。與下列兩個既有「epoch」嚴格區分，程式與 wire 一律用 `sessionEpoch` 全名：
  - RecordCrypto 信封的 `epoch`＝房間內容金鑰代（keyx 輪替）；
  - SenderKeyManager 的 `senderKeyEpoch`＝sender key 輪替代。
- **現行代（accepted epoch）**：收端對某 sender 已在「通過驗簽＋身分綁定」的訊息中觀察到的最高 sessionEpoch。per-(roomId, senderId) 追蹤並持久化。
- **legacy 紀錄**：v1 時期落盤、簽章不含 sessionEpoch 的紀錄；遷移後標記 sessionEpoch=0。

### 4.3 線上格式（wire format）

GossipMessage v2 新增必要欄位（無選填餘地；缺欄位即整則拒收）：

| 欄位 | 型別 | 必選 | 語義 |
|---|---|---|---|
| sessionEpoch | integer（safe integer，≥1） | 必 | sender 自宣告會話代；簽章覆蓋 |

其餘欄位不變（roomId、senderId、pubKey、seq、timestamp、content、ttl、signature、messageId?、channel?、hlc?）。seq 語義不變（per 裝置 reserve-then-send 全域遞增，不分代重起）；訊息身分＝**(senderId, sessionEpoch, seq)**。

```json
{
  "roomId": "room-1", "senderId": "ab12…", "pubKey": "…", "seq": 7,
  "sessionEpoch": 1752800000123, "timestamp": 1752800012345,
  "content": "…", "ttl": 8, "signature": "…", "messageId": "…", "channel": "chat"
}
```

antiEntropy digest v2（GOSSIP_DIGEST payload 與信使 SYNC digest 共用）：每 sender 一個條目，**只宣告該 sender 的現行代**，條目新增 `epoch`：

```json
{ "<senderId>": { "epoch": 1752800000123, "floor": 1, "max": 12, "missing": [3] } }
```

版本欄位：gossip 協議版本由 1 升 2；訊號見 4.7。缺 `epoch` 的 v1 digest 在 normalizeDigest 形狀檢查即失敗，fail-closed 整份忽略。

### 4.4 密碼學語義

- 簽章覆蓋欄位與序列化順序（凍結）：`JSON.stringify({ roomId, senderId, pubKey, seq, sessionEpoch, timestamp, content, [messageId], [channel] })`，SHA-256 後 ECDSA P-256 簽章。sessionEpoch 插在 seq 之後、timestamp 之前。ttl 仍排除（可變路由欄位，五根因修復不動）。messageId/channel 仍為「有值才進序列化」。
- 驗證規則（fail-closed，逐項任一失敗即整則拒收）：形狀（sessionEpoch 為 safe integer ≥1）→ 現行代門檻（低於已知現行代直接拒，見 4.5）→ 簽章驗證（maxAgeMs: null 不變）→ pubKey↔senderId 身分綁定 → 高於現行代則採納新代。
- epoch 配發（sender 側，比照 reserveSeq 的 reserve-then-send）：`reserveSessionEpoch = max(持久化的下一值, Date.now())`，持久化下一值＝配發值+1。每個 handler 生命週期（進房會話）配發一次，惰性於首次發送時取得。Date.now() 下限是「清儲存／換裝置 epoch 歸零」的配套：正常時鐘下，新裝置首代必然高於舊裝置任何代（舊代也是由更早的 Date.now() 種出）。無持久層（記憶體模式）＝ Date.now()。
- 採納規則不可偽造：epoch 只在通過簽章與身分綁定後才會被採納為現行代，攻擊者無 sender 私鑰即無法推高或偽造任何 sender 的代；重放者手上最高的代就是 sender 真實現行代（重放它＝正常 gossip，(senderId, epoch, seq) 去重處理）。

### 4.5 狀態機與時序（接受規則）

收端 per-(roomId, senderId) 持久追蹤 acceptedEpoch，初始未知：

1. `msg.sessionEpoch < acceptedEpoch` → 完全拒收（不入 store、不上 UI、不轉發；計 peerScoring duplicate，不計 invalid——簽章本身合法）。
2. `msg.sessionEpoch == acceptedEpoch` → 走既有管線：(senderId, epoch, seq) 去重＋inflight 預佔＋per-(sender, epoch) floor → 驗簽 → 身分綁定 → 入 store、通知、轉發。
3. `msg.sessionEpoch > acceptedEpoch`（含初始未知）→ 驗簽＋身分綁定通過後採納新代（持久化 best-effort）、接受該訊息；同時把該 sender 記憶體 store 中較舊代的桶剪除（成為 inert 歷史，持久層保留供本機一致性，不再宣告不再補送）。
4. 自己的訊息：首次發送時配發本會話代；自己的 acceptedEpoch 同步推進。

時序保證：epoch 門檻不含任何 wall-clock 判斷。現行代內 30 分鐘（或任意久）前簽出的訊息經 anti-entropy 補送照常接受（V2 回歸鎖）；未來時間戳 30 秒拒絕不變。

### 4.6 antiEntropy 與去重鍵分代

- store 結構：`Map<senderId, Map<sessionEpoch, Map<seq, GossipMessage>>>`；floors per-(senderId, epoch)（單列 meta 存現行代 floor，舊代 inert 無 floor 語義）。
- computeDigest 只輸出每 sender 現行代的 {epoch, floor, max, missing}（成員以 acceptedEpoch 為準；信使無驗證脈絡，以持有紀錄的最高代為準）。
- peerLacks(digest, senderId, epoch, seq)：對方無該 sender 條目 → 缺；對方條目 epoch < 我方 → 全缺（我方紀錄會把對方推進到新代）；對方條目 epoch > 我方 → 不缺（我方已過時，不送徒勞紀錄）；相等 → 沿用 floor/max/missing 判定。
- 收斂性：同代之內數學論證不變（對稱差嚴格縮小）；跨代由「新代紀錄單向推進舊代持有者」收斂到全員現行代聯集。模擬測試加代際切換劇本。

### 4.7 版本協商與錯誤相容（Q3）

- mesh 連線在 bus 開通時互送 `GOSSIP_HELLO`（gossip namespace，payload `{ v: 2 }`），語義同 HelloNegotiator strictProtocols 的相等判定：收到 v ≠ 2 → 標記該 peer 協議不合。v1 節點會忽略未知 envelope type、且永不送 GOSSIP_HELLO；故「收到缺 sessionEpoch 但其餘形狀完好的 gossip 訊息」為舊版確證，與版本不合走同一事件。
- 不合處置：MeshGossipManager 曝露 onProtocolMismatch 事件 → MeshChatService → 兩線 UI 提示「協議版本不相容，請雙方更新後重新整理」，不靜默降級、不嘗試互通（v1 驗 v2 簽章必失敗、v2 對 v1 缺欄位必拒收，分裂是事實，提示讓它 fail-visible）。
- 星型 2 人路徑不走 gossip，P2PManager 的 HelloNegotiator 不動。
- 未知欄位：收端忽略 GossipMessage 未知欄位（既有行為）；未知 digest 欄位忽略、已知欄位形狀錯整份拒。

### 4.8 持久層遷移（Q4）

- `IGossipPersistence` 擴充：`reserveSessionEpoch(roomId, senderId)`、`saveAcceptedEpoch(roomId, senderId, epoch)`；`loadRoom` 回傳加 `acceptedEpochs`；`saveRecord`／`evictRecord` 帶 sessionEpoch；floors 帶 epoch。
- Dexie `NeriloReplica` v2：records 主鍵含 sessionEpoch，主鍵不可變 → 新表 `records2`（`[roomId+senderId+sessionEpoch+seq], roomId`），upgrade 交易內把 v1 rows 抄入（sessionEpoch 取紀錄內欄位，缺＝0 legacy）並清空舊表。versionchange 交易原子：中斷即整體回滾、下次開啟重試，天然可中斷恢復。meta 加 `nextSessionEpoch`、`acceptedEpoch`、`floorEpoch`（v1 floor 遷為 floorEpoch=0，隨 legacy 一起 inert）。
- legacy（sessionEpoch=0）紀錄：hydrate 進 0 號桶，永不等於任何現行代（現行代 ≥1）→ 不宣告、不補送、不擋新代；聊天歷史顯示由應用層 chatStorage 承擔，不受影響。

### 4.9 信使（Spec 003 相容，Q4）

- CourierService 的 buildRoomStore／reconcile／runCourierBackup 隨 digest v2 與巢狀 store 改簽名；信使本體維持盲（照存照服，digest 以持有最高代計）。
- **信使回填收緊**（新增防護，堵既有注入面）：runCourierBackup 的 ingest 目前直寫持久層；改為先驗簽＋身分綁定＋sessionEpoch 形狀＋現行代門檻（epoch ≥ 已持久化 acceptedEpoch，較高則採納）才落地。legacy／舊代紀錄一律不落地。
- 舊格式寄存紀錄退場：v2 收端一律拒收（缺 sessionEpoch），無豁免通道；信使側殘量靠 byte-day 計價與墓碑自然清退，不另寫遷移程式。Protocol Spec 003 的 record 定義隨 GossipMessage v2 連動（record＝已簽名 GossipMessage，欄位跟著 4.3）。
- 實作階段補記（spec 活文件條款）：CourierStore 內部寄存槽位維持 (senderId, seq) first-write-wins 鍵（連動 Spec 003/004 的持久 schema 與計量，本 spec 不動）。後果：sender 換裝置後，同 seq 的新代紀錄在「仍持有舊代同槽紀錄」的信使處會被 duplicate 拒收——只損備份冗餘，不損恰好一次（收端現行代門檻必拒舊代補送，正確性不受影響）；靠信使 TTL/墓碑自然清退。列 QA 已知限制。

### 4.10 安全考量（誠實邊界）

- 已收斂：同裝置與已持久收端的跨會話重放（acceptedEpoch 落盤，重載即拒）；預佔槽位（去重鍵分代後結構上不可能，任何情況下皆然）。
- 殘留一（自宣告代的固有限制）：全新 store 的收端在「尚未從任何管道觀察到該 sender 現行代」的窗內，仍會把舊會話重放當現行接受（舊內容重現、有界：一旦看到更高代即採納並拒後續舊代；佔位仍不可能）。列風險登記追蹤。
- 殘留二：清儲存＋系統時鐘倒退的 sender，其新代可能低於他人已採納的代 → 該 sender 被拒收直到時鐘越過舊代（fail-closed 方向的錯，不破壞不變量）。文件揭露。
- 拒收不計 invalid 信譽分：重放訊息簽章合法，計 invalid 會讓攻擊者藉重放他人訊息毒化無辜轉發者的信譽。

### 4.11 影響面清單

GossipMessageHandler（接受規則、去重鍵、巢狀 store、epoch 配發）、SecurityManager（簽章序列化 v2）、antiEntropy（digest v2）、GossipPersistence/GossipReplicaStore（介面與 Dexie v2 遷移）、MeshConnection＋MeshGossipManager（GOSSIP_HELLO、mismatch 事件）、MeshChatService＋兩線 UI（版本提示）、CourierService（digest/store 簽名、ingest 收緊）、types（GossipMessage.sessionEpoch 必要欄位）、模擬與全部相關測試。SDK 公開面：GossipMessage 型別變更屬 0.x 破壞性變更，隨版本說明揭露。

## 5. 任務分解（tasks）

GossipMessageHandler／SecurityManager／antiEntropy／GossipReplicaStore／CourierService 皆運作中路徑，標 ⚠ 走 harden-tests：characterization-first、新行為先寫失敗測試、分層閘門（type-check → 受影響單元 → 全單元 → E2E → ci）。

- [x] T1 ⚠ 基線釘現況：受影響測試套件（GossipMessageHandler、SecurityManager、antiEntropy×3、GossipReplica、CourierService、MeshGossipManager 系列）與 type-check 全綠存證。
- [x] T2 ⚠ 型別＋簽章：GossipMessage.sessionEpoch 必要欄位；SecurityManager 序列化 v2（先寫失敗測試：簽章覆蓋 sessionEpoch、竄改 epoch 驗簽必敗）。
- [x] T3 ⚠ 接受規則核心：GossipMessageHandler 巢狀 store、(senderId, epoch, seq) 去重＋inflight、per-(sender, epoch) floor、reserveSessionEpoch 惰性配發、acceptedEpoch 追蹤＋採納＋舊桶剪除、Q6 完全拒收；V1 重放與預佔槽位劇本測試；V2 回歸鎖（30 分鐘補送、maxAgeMs: null）不動搖。
- [x] T4 ⚠ antiEntropy digest v2：computeDigest/normalizeDigest/peerLacks/recordsPeerLacks 分代；simulation 加代際切換劇本、多 seed。
- [x] T5 ⚠ 持久層：IGossipPersistence v2、GossipReplicaStore Dexie v2 原子遷移（含 legacy=0 標記與中斷恢復論證）、acceptedEpoch/nextSessionEpoch 落盤；GossipReplica 測試補遷移案例。
- [x] T6 版本訊號：MeshConnection GOSSIP_HELLO、MeshGossipManager onProtocolMismatch（含「缺 sessionEpoch 的舊版 gossip 訊息」確證路徑）、MeshChatService 轉發、兩線 UI 提示。
- [x] T7 ⚠ 信使：buildRoomStore/reconcile/runCourierBackup 隨 v2 改簽名；ingest 收緊（驗簽＋身分＋epoch 門檻）；useCourierNode 接線更新；CourierService 測試補舊代拒收。
- [x] T8 conformance：測試向量 C1-C7 落地（specs/009 conformance 章節＋可執行 spec），見第 6 節 V6。
- [ ] T9 收尾：`npm run ci` 全綠、E2E 診斷、CURRENT-STATUS／QA-REPORT 已知限制／risks.csv R1、ADR-0033 定稿、spec 狀態更新。

## 6. 驗收（黃金判準，沿用 mesh-correctness skill 四層驗收，缺一不可）

- [ ] V1 重放專項轉綠：舊會話錄下的合法已簽名訊息注入新會話，依 Q6 拍板的口徑被拒（ADR-0026 驗收條款）；含「預佔槽位」劇本（重放後 sender 新訊息不得被誤判重複）。
- [ ] V2 補送回歸鎖不動搖：`GossipMessageHandler.spec.ts` 的 30 分鐘舊訊息補送整合測試與 `maxAgeMs: null` 案例、`SecurityManager.spec.ts` 時效窗與 ttl 案例維持綠，不得以放寬斷言湊綠。
- [ ] V3 單元全綠：`npm run test:run`（基線 124 檔／1421 tests）。
- [ ] V4 確定性模擬：`tests/unit/antiEntropy.simulation.spec.ts` 多 seed 全過。
- [ ] V5 E2E 診斷：`tests/e2e/mesh-diagnostic.spec.ts` 3 人矩陣連續 5 次全 =1（`npm run test:e2e:ci`，需 Java 21+）。
- [x] V6 protocol 軌 conformance：測試向量落地於 `tests/unit/SessionEpochConformance.spec.ts`（真 ECDSA 簽章，非 mock），他人實作跑得過等價向量即相容：
  - C1 舊會話重放必須拒收（已知現行代後，較低 sessionEpoch 的合法簽章訊息不入 store、不上 UI、不轉發）
  - C2 補送輸入必須接受（現行代、30 分鐘前 timestamp、ttl=0 → 恰好一次呈現；重複補送去重）
  - C3 預佔槽位失效（舊代 (E1, seq1) 先佔，現行代 (E5, seq1) 仍必須被接受；採納後舊代拒收）
  - C4 sessionEpoch 有簽章保護（竄改 epoch → 驗簽必敗、拒收）
  - C5 缺 sessionEpoch 的 v1 訊息整則拒收並發出版本不合確證
  - C6 digest v2 形狀（v1 digest fail-closed 整份忽略；對方代落後 → 現行代全補；對方代較新 → 不送）
  - C7 未來時間戳仍一律拒絕（不受 maxAgeMs: null 影響）
- [ ] V7 收尾文件：`docs/CURRENT-STATUS.md`、`docs/QA-REPORT-chat.md` 已知限制清單、`docs/audit/core-invariants-risks.csv` R1 狀態同步更新。

## 7. 一致性自查（analyze，implement 前跑一次）

- [ ] 第 4 節方案覆蓋第 1 節全部需求（含威脅模型兩種攻擊效果），無多做
- [ ] 第 5 節任務完整實現第 4 節，無遺漏
- [ ] 第 6 節驗收能證明第 1 節，不是只證明「程式跑得動」
- [ ] 未違反憲法任何一條（特別是不變量聲明與 protocol 軌加嚴條款）
