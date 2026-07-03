# ADR-0005：伺服器端配額與速率限制

- 狀態：Proposed
- 日期：2026-07-03

## Context

目前所有限流都在 client 端記憶體（core/relay/RateLimiter.ts：每 peer 100 則/10 分鐘），
惡意 client 開 DevTools 即可繞過，直接對 Firestore 寫入。firestore.rules 只驗證
單筆資料的大小（10KB）與時間戳（正負 30 秒），沒有任何頻率或總量控制：

- 房間建立無上限（RoomService 無配額檢查）
- 信令、relay、inbox 寫入無每用戶總量限制
- store-and-forward 收件匣 24 小時 TTL 但無容量上限

估算：單一惡意帳號可製造每分鐘 20 萬次以上寫入，約每小時 1000 USD 等級的帳單。
免費層限額（ADR-0008 的升級動機）也需要同一套機制承載。

## Decision

三層防線，由便宜到昂貴：

1. **Firestore rules 層（立即）**：結構性限制。
   房間 participants 上限 5 人（建立與加入路徑皆驗，**2026-07-03 已實作**：
   participantsWithinCap()，client 端 RoomService 同步給 room-full 友善錯誤）。
   原規劃的 activeRoomCount 計數器**改列 Functions 層**：計數器需要所有
   建/關/清理路徑維持一致，任何漂移（例如清理函式刪房未減數）會把使用者
   永久鎖死在上限，維運風險大於防護收益；房間建立的頻率與總量控制
   移至第 2 層以伺服器端狀態實作。
   rules 無法做頻率限制，這層只擋「單文件結構總量」。
2. **Cloud Functions 配額層（需 Blaze，見 ADR-0006）**：高頻寫入路徑
   （relay fallback、inbox）改為 callable function 入口，function 內查
   per-user 滑動視窗計數（Firestore 分片計數器或 Realtime Database），
   超額回 429。client 的 RateLimiter 保留作為第一道自律，不再是唯一防線。
3. **監控斷路層**：預算警報加上排程 function 定時檢查寫入異常，
   超閾值時將濫用帳號的 custom claim 標記為 suspended，rules 一律拒絕
   suspended 帳號寫入。

配額參數集中於一個設定檔（免費層預設值：同時 1 個活躍房間、
每房 5 人、fallback 每用戶每日 500 則），與 ADR-0008 的方案分層共用。

## Consequences

- 成本上限從「無界」變成「配額乘以用戶數」，單位經濟可計算。
- 高頻路徑多一跳 function 呼叫，fallback 延遲增加數十毫秒。可接受，因為 fallback 本來就是降級路徑。
- Functions 依賴 Blaze 方案，本 ADR 阻塞於 ADR-0006。
- rules 計數器有競態限制（transaction 保護），極端並發下可能少算，方向是「寬鬆但有界」，可接受。
- 誤封風險：suspended 機制需要人工復原管道，最小可行為支援信箱。
