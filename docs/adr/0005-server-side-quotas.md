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

1. **Firestore rules 層（立即）**：用文件內計數器做結構性限制。
   使用者文件記錄 activeRoomCount，rules 拒絕超過方案上限的房間建立；
   房間文件記錄 participants 數量上限（免費層 5 人）。
   rules 無法做頻率限制，這層只擋「總量」。
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
