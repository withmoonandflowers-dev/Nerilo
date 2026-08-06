# Spec 018：修復產生方交接的 epoch 碰撞（keyx 第四道閘門）

- 軌別：feature
- 狀態：done（2026-08-03：CI e2e-7p R6/R7/R8 連續 3 綠）
- 建立：2026-08-03／最後更新：2026-08-03
- 關聯：Spec 016 殘留 E（CI 第五輪實證）、Spec 017、ADR-0023 P2-②c

## 1. 要做什麼、為什麼（specify）

逐一加入的房間存在多個「先後都合法完整」的名冊版本，min-uid 產生方隨人數變化
換人。新任 min-uid（晚加入者）的金鑰環在消費到前任 keyx 之前是空的
（getMaxKnownEpoch() = -1），三道閘門全數通過即以 epoch 0 再生成分發
→ 與前任的 epoch 0 同代異鑰碰撞，金鑰環互蓋、部分成員持錯鑰。
CI 第五輪實證：U5 於 rosterSize 5 發 epoch 0，晚加入的 U7 於 rosterSize 7
再發 epoch 0，U6/U7 各 14 次解密失敗，7p 矩陣紅。
三道閘門防「殘缺名冊搶發」（空間性分裂視圖），防不了「跨時間交接」；
Spec 017 的 self-seal 只解單一產生方的自我復原，不涉跨產生方。

**憲法檢核**：
- 目標函數：隱私韌性（金鑰環分歧＝訊息不可讀）；可維運（7p 連續綠的最後一塊產品拼圖）。
- 四條不變量：E2EE 機密性，有影響，方向為修復（不動演算法與信任模型，只動
  分發時機）。恰好一次：間接受益。帳本、身分：無。

## 2. 邊界（明確不做）

- 不動 keyx 線上格式、三道既有閘門語義、epoch 單調規則。
- 不動 bootstrap 行為：全新房（store 無他人紀錄）分發時機與現狀完全一致
  （characterization 保持）。
- 不處理 Spec 016 殘留 D（分島）。

## 3. 待釐清（clarify）

無使用者層歧義（需求唯一：交接不得分叉金鑰環）。等待窗長度屬技術參數，
取捨記於 plan。

## 4. 技術計畫（plan）

**第四道閘門（listen-first 交接寬限）**：`RoomKeyCoordinator.tick()` 在既有三道
閘門後、分發前加判：金鑰環空（maxKnownEpoch = -1）**且**本機 store 已有他人
紀錄（房間已運轉的證據，keyx 極可能在 anti-entropy 路上）→ 延遲本輪分發，
連續延遲上限 `HANDOVER_GRACE_TICKS = 3`（tick 4s → 約 12s，涵蓋 anti-entropy
2s 週期數輪）。窗內收到 keyx → 環非空，之後若名冊變動即以 max+1 正常遞增
（單調，無碰撞）。窗盡仍無 keyx（例如既有成員全為無 ecdh 舊 client 的明文房
，理論案例，閘門 1 通常早已擋）→ 照發 epoch 0，liveness 有界。

依賴注入：deps 加選填 `hasForeignRecords?: () => boolean`（預設 () => false，
既有測試與呼叫端零改動）；GossipMessageHandler 加 `hasRecordsFromOthers()`
（store 含 senderId ≠ 自己的紀錄）；MeshGossipManager 接線。

**〔實作期修訂〕交接基底 = 觀察到的 epoch，非安裝的 epoch**：整合測試立刻暴露
第一版盲點，新加入者根本開不了既有 keyx（未封給他，前向保密的本意），
getMaxKnownEpoch 永遠 -1，等待窗形同虛設，且現任產生方因不再是 min-uid 永不
重發 → 交接死鎖。出路：keyx 的 `keys[].epoch` 是明文 metadata，開不了鑰也讀得到。
加 `GossipMessageHandler.getMaxObservedKeyxEpoch()`（掃 store 的 keyx 紀錄取最高
epoch）與 deps `getMaxObservedEpoch?`；閘門 4 改「環空且未觀察到任何 keyx」才等；
分發基底 = max(已安裝, 已觀察) + 1。新任 min-uid 觀察到 epoch 0 即以 epoch 1
交接分發（封給全員含現任），前向保密不破、單調成立。

**取捨**：不採「一律延遲首次分發」，懲罰全新房的 E2EE 就緒時間（exit gate
會扣訊息 12s，UX 可感）；不採「以 joinedAt 判斷誰先來」，名冊 deps 不帶
joinedAt，擴 deps 面大且時鐘語義另起爭議。store 他人紀錄是「房間已運轉」的
最小充分證據，且 anti-entropy 保證它比 keyx 更早或同批到達。

## 5. 任務分解（tasks）

- [x] T1 ⚠ characterization：RoomKeyCoordinator／MeshKeyxIntegration 既有單元綠。
- [x] T2 GossipMessageHandler.hasRecordsFromOthers() ＋單元。
- [x] T3 ⚠ RoomKeyCoordinator 第四道閘門＋單元：(a) 環空＋他人紀錄 → 延遲；
  窗內 keyx 到 → 名冊變動時以 max+1 分發；(b) 環空＋無他人紀錄（bootstrap）→
  立即分發（現狀不變）；(c) 窗盡無 keyx → 照發（liveness）。
- [x] T4 整合劇本（MeshKeyxIntegration）：交接競態，既有雙節點 epoch 0 收斂後，
  更小 uid 的新節點加入並先收到 backfill 再收 keyx → 不再出現第二把 epoch 0；
  全場收斂單一金鑰鏈，epoch 單調；新舊訊息全員可解。
- [x] T5 驗收：全單元 1562；rejoin 8 輪 7 綠（單次傳輸尾巴，閘門 inert 佐證非本 spec）；3 人矩陣綠；CI 7p R6/R7/R8 連續 3 綠。
- [x] T6 文件：ADR-0023 修訂八、CURRENT-STATUS、Spec 016 殘留 E 收口註記。

## 6. 驗收（黃金判準）

- T3/T4 新測試綠（T4 為修前紅/修後綠的行為級證明）。
- 全單元綠；rejoin 連 3 綠；3 人矩陣綠（bootstrap characterization 不動搖）。
- CI e2e-7p dispatch 至少 1 綠（交接碰撞是第五輪唯一死因，修掉即應過）。

## 7. 自查（analyze）

- [x] 方案覆蓋需求：交接窗被 listen-first 寬限覆蓋；bootstrap 不受罰；liveness 有界。
- [x] 任務覆蓋方案：T2 證據源、T3 閘門、T4 整合證明、T5 驗收、T6 文件。
- [x] 驗收證明需求：T4 直接重演 CI 第五輪劇本。
