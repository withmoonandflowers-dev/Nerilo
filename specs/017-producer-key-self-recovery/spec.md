# Spec 017：修復產生方 rejoin 金鑰自我復原缺口

- 軌別：feature
- 狀態：done（mesh-e2ee 裁定除外，見驗收註記）
- 建立：2026-08-02／最後更新：2026-08-02
- 關聯：Spec 012（hydrate 重放 keyx）、ADR-0023 P2-②c（keyx 分發）、
  mesh-correctness 殘留「rejoin 既有 flake（金鑰時序家族）」

## 1. 要做什麼、為什麼（specify）

rejoin flake 根因實證（2026-08-02，rejoin-r*.log，10 輪 6 紅，全部同一簽名）：
產生方（名冊 min-uid）分發 keyx 時只封給別人（`others = eligible.filter(≠自己)`），
自己的金鑰走 `applyLocalKey` 記憶體安裝。重進（新 session）後 hydrate 回放自己
store 裡的 keyx 紀錄，`consumeKeyx` 找不到 `forMember === 自己` 的份 → 靜默無效
（keyxReplayed 計數照加，Spec 012 的防線形同虛設）→ `getMaxKnownEpoch() = -1`
→ coordinator 以 epoch 0 重新生成分發 → 與對方手上的舊 epoch-0 鑰同代不同鑰，
金鑰環永久分歧，對方之後的訊息在重進端全部 `OperationError`。
是否踩中取決於重進者是否為 min-uid（每輪隨機），故呈 ~50% flake。

**憲法檢核**：
- 目標函數：可維運（@vue-stable 的 rejoin 從 flake 變穩）；隱私韌性（金鑰環
  分歧＝訊息丟失風險，修復即韌性）。
- 四條不變量：E2EE 機密性——**有影響，方向為修復**：不動加密演算法與信任模型，
  只把產生方自己納入封裝對象（用自己的 ECDH 公鑰封給自己，等價於既有成對封裝的
  退化情形）。恰好一次：間接受益（解密失敗不再造成可見訊息缺失）。帳本、身分：無。

## 2. 邊界（明確不做）

- 不動 keyx 線上格式（`keys[]` 多一個 self 條目，schema 同形、舊 client 讀得懂
  也不受影響——多的條目 forMember 不是它就跳過）。
- 不動三道分發閘門與 epoch 單調語義。
- 既有房間的舊 keyx 紀錄（無 self 條目）不回補：下次名冊變動自然輪替出含 self
  條目的新 epoch；過渡期間該房產生方 rejoin 仍可能踩舊路徑，屬已知殘留，
  隨新 keyx 覆蓋自癒。

## 3. 待釐清（clarify）

無使用者層歧義（需求唯一：rejoin 不得分歧金鑰環；技術取捨見 plan）。

## 4. 技術計畫（plan）

`RoomKeyCoordinator.tick()` 的封裝對象由 `others` 改為 `eligible` 全體（含自己）。
`consumeKeyx` 無自我守衛（實測確認），`openSealedRoomKey` 對 self-ECDH
（自己私鑰 × 自己公鑰）為合法運算。回放時產生方即可從自己的紀錄開回金鑰
→ `getMaxKnownEpoch()` 正確 → 重進後若再分發必為新 epoch，同代碰撞在構造上消失。

**取捨**：不採「持久化產生方金鑰材料」（新增儲存面與金鑰落盤風險）；
不採「持久化 epoch 計數器」（防到碰撞但重進端喪失舊 epoch 歷史解密能力）。
封給自己一併保住歷史解密，改動面最小。

## 5. 任務分解（tasks）

- [x] T1 ⚠ characterization：GossipKeyx／MeshKeyxIntegration 既有單元綠（錨點）。
- [x] T2 修 RoomKeyCoordinator 封裝對象含自己＋單元測試：
  (a) 分發出的 keys[] 含 self 條目；(b) 產生方以新 handler 回放自己的 keyx
  → 金鑰環重建、maxKnownEpoch 正確；(c) rejoin 整合劇本（記憶體 gossip）：
  產生方重生後不再出現同 epoch 異鑰，對方訊息可解。
- [x] T3 驗收執行：全單元；rejoin E2E 10 輪（目標 10/10）；mesh-e2ee／
  mesh-diagnostic 3 人矩陣回歸；React @stable 護欄。
- [ ] T4 文件：QA-REPORT 已知限制更新、CURRENT-STATUS、ADR-0023 修訂註記。

## 6. 驗收（黃金判準）

- 新單元測試三例綠；全單元綠。
- `rejoin.spec.ts` 連續 10 輪綠（修前基線 10 輪 6 紅）。
- mesh-e2ee、3 人矩陣、React @stable 不動搖。
- 驗收結果（2026-08-02）：rejoin 10/10（基線 6/10 紅）、3 人矩陣 3/3、React @stable
  綠、全單元 1548。mesh-e2ee 本機 4/4 紅，但 stash 對照證實與本修復無關（無修復同紅），
  且當時機器被兩個論文重跑程序佔 2 核（load 14-25）；該 spec 不在 @vue-stable 與
  E2E Full 涵蓋範圍，屬本機限定未裁定項，待安靜環境重跑。

## 7. 自查（analyze）

- [x] 方案覆蓋需求：self 條目使回放可復原 → epoch 不歸零 → 碰撞構造上消失。
- [x] 任務覆蓋方案：T2 = 實作＋三層測試；T3 = 驗收；T4 = 文件。
- [x] 驗收證明需求：以修前 6/10 紅為對照，10/10 綠是行為級證明，非「跑得動」。
