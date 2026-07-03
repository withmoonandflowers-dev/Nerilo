# ADR-0002：Firebase 作為信令與 fallback 後端（補記）

- 狀態：Accepted（既有決策回填）
- 日期：2026-07-03（決策實際發生於專案初期）

## Context

P2P 聊天需要三件伺服器端能力：身分認證、WebRTC 信令交換、P2P 失敗時的訊息中繼。
單人開發，沒有維運自建後端的餘裕。

## Decision

全部採用 Firebase：Auth 做身分、Firestore 做信令（p2pRooms/{id}/signals）與
fallback 中繼（relay、messages、inbox 子集合）、Hosting 做部署。
安全模型以 firestore.rules 白名單為主（deny by default、簽章者自寫、
時間戳防重放、10KB 信令上限）。

## Consequences

- 零維運成本起步，rules 模型經稽核評為良好。
- 代價一：fallback 每則訊息就是一次計費寫入，P2P 成功率直接決定帳單（見 ADR-0005）。
- 代價二：rules 無法表達「每用戶每分鐘寫入上限」這類頻率控制，配額必須靠 Cloud Functions 補（見 ADR-0005、0006）。
- 代價三：與 Google 生態鎖定。可接受，因為 transport 層已有抽象（IIncentiveProvider、ports 模式），未來抽換成本有限。
- 商業化階段不推翻此決策：替代方案（自建 signaling server）增加的維運負擔與目前團隊規模不相稱。
