# Spec 020：rejoin 重建改用「有進展就續等」的截止判準

- 軌別：feature
- 狀態：done（2026-08-03：rejoin 8/8、矩陣與 @vue-stable 綠）
- 建立：2026-08-03／最後更新：2026-08-03
- 關聯：QA-REPORT「rejoin 傳輸尾巴」診斷（2026-08-03, 1aa45a2）、ADR-0023 P2-③

## 1. 要做什麼、為什麼（specify）

rejoin 重建的截止判準是**盲目牆鐘**：`REJOIN_READY_TIMEOUT_MS`(15s) 一到就 close +
排重試。但該常數自身的註解記載「實測 rejoin 首連常落在 13-15s」，門檻與實測分布
幾乎無餘裕，稍慢即誤殺一個**正在成形**的連線；誤殺後再走一輪握手（又 13-15s）
即吃掉使用者感知窗（rejoin.spec 30s 斷言窗，本機 8 輪 1 紅）。
期間留房者已 close、重進者仍自認 `neighborCount: 1` 續送入黑洞（拆線不對稱），
訊息需等新連線成形後由 anti-entropy 補齊。

**憲法檢核**：
- 目標函數：可維運（@vue-stable 成員的既有 flake）；隱私韌性（rejoin 是日常路徑，
  送達延遲直接是使用者可感的「重進後對方收不到」）。
- 四條不變量：恰好一次，間接受益（不改去重與對帳，只讓連通更早成立）；
  E2EE／帳本／身分：無。

## 2. 邊界（明確不做）

- 不動 perfect negotiation、發起方裁決、signaling 格式（歷史上翻車兩次之處）。
- 不動首次連線的 `CHANNEL_READY_TIMEOUT_MS`(30s) 語義。
- 不做拆線對稱化通知（診斷中的方向 (b)），需新 wire 訊息，範疇大且非主因；
  主因修掉後若仍見黑洞窗再議。
- **不盲目加長常數**（誠實條款）：改的是判準本身，不是把牆往後推。

## 3. 待釐清（clarify）

無使用者層歧義。寬限長度與進展判準見 plan。

## 4. 技術計畫（plan）

`MeshConnection.initialize()` 的 ready 等待改為兩段式截止：

- 第一段 = `readyTimeoutMs`（rejoin 15s／首連 30s，維持不變）。
- 到期時**檢查是否有具體進展**，兩個訊號任一為真即視為「正在成形」：
  1. `p2pManager.getChannelBus() !== null`（DataChannel 物件已建立＝signaling 已完成，
     只差 open）；
  2. `p2pManager.getConnectionManager().getState() === 'connected'`（pc 已連通）。
- 有進展 → 授予**一次**寬限 `READY_GRACE_MS`(10s) 續等；寬限內 open 即成功，
  仍不 open 才 reject（訊息含 grace 標記便於日後量測）。
- 無進展（連 bus 都沒有＝signaling 卡住）→ 行為與現狀完全一致，立即 reject 讓
  乾淨重試接手（保住「最壞 rejoin ~20s」的原始設計意圖）。

**取捨**：不採「一律加長到 25s」，會連「真的卡死」的情形也拖慢重試，正是原註解
要避免的 churn；進展判準只放行「差最後一哩」的連線。寬限 10s 的上界：
15+10=25s < rejoin.spec 的 30s 斷言窗，仍留餘裕給 anti-entropy 補齊。

## 5. 任務分解（tasks）

- [x] T1 ⚠ characterization：MeshConnection 相關既有單元 + rejoin/mesh-diagnostic 現況。
- [x] T2 ⚠ 兩段式截止實作 + 單元（fake timers）：(a) 無進展 → 15s 即 reject（現狀不變）；
  (b) 有 bus 但未 open → 續等，寬限內 open 則 resolve；(c) 寬限亦逾時 → reject。
- [x] T3 驗收：全單元 1568；**rejoin 8/8**（基線 8 輪 1 紅）；3 人矩陣綠；@vue-stable 綠。
- [x] T4 文件：QA-REPORT 殘留收口、CURRENT-STATUS、ADR-0023 補註。

## 6. 驗收（黃金判準）

- T2 三例綠（(b) 為修前紅／修後綠的行為級證明）。
- 全單元綠；rejoin 連 8 輪綠；3 人矩陣與 @vue-stable 不動搖。

## 7. 自查（analyze）

- [x] 方案覆蓋需求：誤殺「差最後一哩」的連線＝主因，由進展判準消除。
- [x] 任務覆蓋方案：T2 鎖三種路徑（無進展／有進展成功／有進展仍失敗）。
- [x] 驗收證明需求：以 8 輪基線對照，非「跑得動」。
