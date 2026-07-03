# ADR-0008：計費與授權架構

- 狀態：Proposed
- 日期：2026-07-03

## Context

repo 內沒有任何金流程式碼。LocalCreditProvider 已定義 free/basic/premium
三層概念，但它是 client 端信用點數設計，服務的是「中繼貢獻激勵」而非訂閱計費，
兩者不能混用。方案分層若由前端判斷，付費牆形同虛設。

前置依賴：ADR-0005 的配額機制（免費層限額是升級動機的來源）、
ADR-0006 的 Functions（webhook 接收端）。

## Decision

1. **金流**：Stripe Checkout 加 Customer Portal，不自建結帳頁與卡號處理。
   訂閱制月付，初期單一付費方案（Pro），保持定價面單純。
2. **授權真相源**：Stripe webhook（經 Cloud Function）把訂閱狀態寫入
   Firebase Auth custom claims（plan: free 或 pro）。授權判斷永遠以
   ID token 內的 claim 為準：firestore.rules 直接讀 request.auth.token.plan
   決定配額上限，前端只做顯示。
3. **分層邊界**（初版，與 ADR-0005 配額表共用設定）：
   - Free：同時 1 個活躍房間、每房 5 人、fallback 每日 500 則、TURN 不保證
   - Pro：多房間、每房 20 人、fallback 放寬、TURN 保障（動態憑證優先發配）
   邊界刻意選在「伺服器可強制」的維度上；P2P 直連訊息本身不設限，
   因為技術上無法計量也不產生邊際成本，這正是本產品成本結構的優勢。
4. **LocalCreditProvider 的定位**：不作為計費依據。保留其介面作為未來
   「中繼貢獻折抵訂閱費」的實驗空間，但不在初版範圍。

## Consequences

- 授權執行落在 rules 與 Functions，繞過前端無法提權。
- custom claims 更新後 ID token 需刷新（最長 1 小時延遲，或強制 token refresh），升級後的即時生效需要前端配合呼叫 getIdToken(true)。
- 綁定 Stripe。台灣個人或工作室收款需要可用的 Stripe 帳號主體，若不可行，備案是 Paddle（Merchant of Record 模式，處理跨境稅務），介面層設計成可替換。
- 免費層限額生效即是第一次真實的轉換率實驗，featureLog 的 onboarding 埋點要延伸到 paywall 事件。
- 定價數字本身不在本 ADR 範圍，屬市場決策（ADR-0009 之後定）。
