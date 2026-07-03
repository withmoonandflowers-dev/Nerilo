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

## 附錄：金流供應商查證結果（2026-07-03）

原決策「Stripe 為主、Paddle 備案」經查證修訂：

- **Stripe 台灣不可用**（2026 仍未開放，個人與公司皆無法直接註冊）。
  繞道方案（美國 LLC + EIN + 美國銀行帳戶）對驗證階段過重，
  且帶稅務合規義務（Form 5472 漏報最低罰 25,000 美元），不採。
- **修訂決策：MoR（Merchant of Record）先行**。Lemon Squeezy（Stripe 旗下，
  對個人與小團隊友善）或 Paddle（審核較嚴、適合放量後）。費率約
  5% + 0.5 美元，比 Stripe 貴，但代收代付全球稅務、台灣個人可註冊、
  離「今天就能收錢」最近。介面層維持可抽換（IPaymentProvider），
  放量後可評估轉 Paddle 或屆時的其他選項。
- **台灣本地備選**：綠界/藍新（可用花朝月夕工作室統編，NTD 定期定額），
  適合台灣優先的封閉驗證；跨境客群仍需 MoR。兩者不互斥。
- **webhook 免 Blaze 方案**：MoR webhook 端點不必用 Cloud Functions——
  可用 Netlify Functions（免費層）承載，內用 firebase-admin service account
  設 custom claims。這解除 ADR-0008 對 ADR-0006（Blaze）的依賴，
  M3 可以完全在免費基礎設施上完成。
