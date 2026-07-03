# ADR-0014：多裝置身分與同步

- 狀態：Proposed（缺口確認，設計方向定，實作未排期）
- 日期：2026-07-03

## Context

產品負責人詢問：同一帳號的兩個裝置能否同步資訊。

現況盤點（皆有程式碼佐證）：**目前完全不同步**，因為身分綁在裝置而非帳號：

- deviceId 是 per-device 的 localStorage 隨機值（utils/uuid.ts:5-11）。
- mesh 身分 userId = sha256(該裝置自己的 ECDSA 公鑰)（IdentityManager），
  金鑰存該裝置的 IndexedDB。兩裝置各自生成金鑰，因此是**兩個不同 userId**。
- E2EE 的 ECDH 金鑰每次 initKeyPair() 重新生成、不持久化（SenderKeyManager）。
- 訊息存各裝置本機的 IndexedDB（IndexedDBService），不外流。

存在一個既有的不一致：房間 participants 用 Firebase Auth uid（per-account），
但 P2P 連線身分用 deviceId / mesh userId（per-device）。同帳號兩裝置加入
同一房間，participants 只記一個 uid，卻有兩條各自身分的 P2P 連線——
這是尚未處理的邊界。

多裝置是即時通訊產品的基本期待（WhatsApp、Signal、Telegram 皆支援），
但在 P2P + E2EE 下是出了名的難題：Signal 為此設計了專門的 Sesame 協議。
天真的做法（伺服器存明文同步）會直接摧毀 GS1 的 E2EE 賣點。

## Decision

確認為缺口，定方向不搶排期（M1 至 M5 皆不含，屬 M4 平台身分統一的延伸）：

1. **身分分層**：引入「帳號身分」（穩定，綁 Firebase uid）與其下的
   「裝置身分」（每裝置一把金鑰）。一個帳號有一組裝置金鑰集合，
   彼此互簽（裝置 A 認證裝置 B 屬於同一帳號）。這對齊 GS3
   （身分原語升格為平台級）與 GC（正確性）的 M4 目標。
2. **群組加密改為對「帳號的所有裝置」分發**：sender key 分發時，
   收件人不是單一裝置而是帳號下所有已認證裝置，每裝置各一份 ECDH 封裝。
   這與現行 SenderKeyManager 的 per-member 分發是同一機制的推廣，
   成本可控。
3. **裝置間同步走 store-and-forward 節點**（ADR-0012 第 2 層）：
   裝置 A 把訊息加密（含給自己其他裝置的副本）存到社群儲存節點，
   裝置 B 上線後拉取解密。這讓多裝置同步與離線投遞共用同一套基建，
   且全程 E2EE——儲存節點看不到明文（content-blind）。
4. **不做伺服器端明文同步**：任何「為了方便同步而讓伺服器存明文」
   的方案一律拒絕，與 GS1 直接衝突。

## Consequences

- 多裝置從缺口變成有明確路徑的 roadmap 項，依賴 M4 身分統一與
  ADR-0012 儲存節點，自然落在 M4 之後。
- 金鑰管理複雜度上升：裝置增刪、撤銷（丟失裝置）、跨裝置金鑰互簽，
  都是 Sesame 等級的協議工作，需要獨立設計文件與充分測試。
- 新裝置加入需要既有裝置授權（掃碼或帳號驗證），是刻意的安全成本，
  防止帳號被盜後任意新增裝置竊聽。
- 在實作前，產品必須誠實標示為「單裝置」，不得暗示跨裝置同步——
  呼應 GP2 誠實原則。
- goal 樹新增 GC5（帳號層一致性：同帳號多裝置的訊息視圖收斂）。
