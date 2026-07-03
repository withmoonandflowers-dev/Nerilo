# ADR-0006：升級 Blaze、部署清理 Functions、設預算斷路器

- 狀態：Proposed（2026-07-03 修訂：加入不升級 Blaze 的替代路徑，見附錄）
- 日期：2026-07-03

## Context

functions/ 內已有五個寫好且通過 CI 編譯的函式（setRole、getIceServers、
cleanupExpiredRooms、cleanupStaleSignals、cleanupExpiredInbox），但從未部署，
因為需要 Blaze 方案與 Cloud Build API（步驟見 PR #15）。後果：

- 正式環境的過期房間、殘留信令、過期收件匣沒有任何清理，資料只進不出。
- ADR-0005 的配額層與 ADR-0008 的計費 webhook 都需要 Functions 存在。
- 不升級 Blaze，商業化路線圖整條被阻塞。

升級 Blaze 的風險是帳單從「不可能超支」變成「可能超支」，
必須與防護措施同一批上線。

## Decision

1. 升級 nerilo 專案至 Blaze，同一天完成以下防護，缺一不可：
   - Cloud Billing 預算警報：50%、90%、100% 三段通知。
   - 每月硬上限的斷路器 function：訂閱 billing Pub/Sub，超過上限
     （初期建議 100 USD/月）自動停用高成本入口（以 feature flag 關閉
     fallback 寫入與 TURN 發配），保留唯讀。
2. 部署三個 cleanup 函式，並在 firebase-deploy.yml 加入 functions 部署步驟
   （移除現有的刻意排除）。
3. 補一個 cleanup 缺口：roomRequests（合併/拆分請求）過期清理，現有函式未覆蓋。
4. getIceServers 部署後，TURN 憑證改為短效動態發配（IceServerProvider 已支援，
   12 小時快取），取代長效靜態 secrets，降低憑證外洩後的濫用窗口。

## Consequences

- 資料保留政策（ADR 見 GOAL-ANALYSIS G4.2）從紙上變成實際運作。
- ADR-0005、0008 解除阻塞。
- 開始有月費成本：cleanup 排程在目前流量下估每月數美元，10k 用戶規模估每月一兩百美元，計入定價成本模型。
- 斷路器誤觸發會讓 fallback 失效（P2P 正常的用戶不受影響），屬於可接受的優雅降級，但需要 Sentry 告警讓維運者第一時間知道。
- GitHub Actions 免費額度（每月 2000 分鐘）因 functions 部署步驟消耗加快，接近上限時 push 會靜默不觸發（已知陷阱，見 CROSS-MACHINE-HANDOFF 第 3 節）。

## 附錄：不升級 Blaze 的替代路徑（2026-07-03）

盤點發現三個 cleanup 函式（cleanupExpiredRooms/StaleSignals/ExpiredInbox）
本質都只是「刪除 ttlExpireAt / expiresAt 已過期的文件」。這正是
**Firestore 原生 TTL policy** 的功能——不需要 Cloud Functions、不需要 Blaze、
零成本。因此 M2 的資料保留問題可以在 Spark（免費）方案內解決。

把 M2 需求拆成兩堆：

**Spark 方案內可做（不升級）：**
- rules 人數上限（已做）。
- Firestore 原生 TTL policy：對 signals、messages、inbox 的 expiresAt/ttlExpireAt
  設 TTL，過期文件自動刪。前置工作：把 RoomService 寫入的 ttlExpireAt 從
  number 改為 Firestore Timestamp（TTL policy 只認 Timestamp 型別）。
- client 端清理：離開房間時刪自己的訊息與信令（rules 已允許 owner 刪除）。

**只有 Blaze 能做（延後到真的需要）：**
- 伺服器端頻率限制（signal/relay spam 防護）——需要一個可信執行點，
  rules 做不到頻率。
- Stripe webhook（M3 計費）。
- getIceServers 動態 TURN 憑證發配（目前用靜態 secrets 也可運作）。

**TTL policy 的已知限制（皆可接受）：**
- 不級聯刪子集合：刪 room 不會自動刪其 signals/messages。解法是三個集合
  各自設 TTL（collection group TTL），不靠 room 刪除觸發。
- 刪除非即時：官方 SLA 最長 72 小時延遲。對「清理過期資料」用途無妨，
  因為 rules 的存取控制不依賴文件是否已被實體刪除。

**修訂後的決策**：Blaze 升級從「M2 阻塞項」降級為「M2 之後、有濫用跡象或
開放公開註冊時才需要」。M2 改用原生 TTL + rules 完成資料保留與結構配額，
留在免費方案。頻率限制（ADR-0005 第 2 層）隨 Blaze 一起延後，
在此之前由 rules 結構限制 + 未公開推廣（流量可控）承接風險。
