# ADR-0013：雲平台選擇（Firebase vs AWS）

- 狀態：Accepted
- 日期：2026-07-03

## Context

產品負責人詢問遷移到 AWS 是否較好。現行後端是 Firebase：
Auth（身分）、Firestore（信令與 fallback）、Hosting（部署），
安全模型以 firestore.rules 承載（ADR-0002）。

## Decision

**不遷移。** 判準是「哪個目標會因為換平台而更好達成」，逐支柱檢視後，
遷移 AWS 對現階段所有支柱皆為中性或負面：

- GB1 成本護城河 / GP3 維護面積：Firebase 的核心價值正是「零維運起步」，
  與單人團隊相稱。AWS 等價堆疊（Cognito + AppSync 或 API Gateway + DynamoDB
  + S3 + CloudFront）維運複雜度高一個數量級，且 rules 這種宣告式安全模型
  要用 IAM + resolver 邏輯重寫，是數週的淨負擔換不到新能力。
- 平台鎖定風險：真實但可控。傳輸層已有抽象（IIncentiveProvider、ports），
  綁定集中在 Auth 與 Firestore signaling，未來要換的面積有界。

**正確的問題不是「AWS 還是 Firebase」，是「哪些元件該用 managed、哪些該自建」**：
- 信令 + Auth：留 Firebase（便宜、免維運，ADR-0002 不推翻）。
- 中繼 + 儲存：交社群（ADR-0012），這些是 runtime 中立的 Node daemon，
  可跑在任何 VPS、樹莓派、雲——包括 AWS EC2。社群節點營運者要用
  AWS 是他們的自由，與平台選擇無關。
- 若未來自建 TURN（coturn）或官方 headless 種子節點：EC2 / 任意 VPS
  適合，這是「補充一台 compute」不是「遷移後端」。

## Consequences

- 維護面積維持最小，符合單人可持續營運的前提。
- 社群節點（ADR-0012）天然多雲，不綁任何單一供應商——去中心化容量本身
  就分散了平台風險，這比「把中心從 Google 搬到 Amazon」更徹底。
- 保留未來局部自建的彈性（TURN、種子節點走 VPS），不需要整體遷移。

## 觸發重新評估的條件

1. Firestore 成本在某規模超過自建同等服務（配合 ADR-0012 社群卸載後，
   此點更難觸發）。
2. 出現 Firebase 無法滿足、AWS 專屬的硬需求。
3. 合約或合規要求多雲或特定資料落地區域。
在此之前，遷移是拿確定的維運成本換不確定的收益。
