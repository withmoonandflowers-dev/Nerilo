# Nerilo 威脅模型（AI 時代）

> 現況快照 2026-07-04。回答「AI 駭客能否攻破」——結論：**破不了密碼學，
> 打的是邏輯與架構**。本文對照真實 code（firestore.rules、crypto/、
> netlify webhook），誠實列出強項與弱點，弱點按 AI 可利用性排序。

## 前提：AI 改變的是規模，不是密碼學

AI 攻擊者**不會**暴力破解 AES-256-GCM / P-256 ECDH / HMAC-SHA256。
它加速的是：偵察、rules 邏輯漏洞挖掘、大量假帳號、憑證填充、
相依套件 CVE 比對、遊戲作弊自動化、規模化釣魚。真正的戰場是邏輯與架構。

## 強項（AI 打不穿）

| 面向 | 控制 | 位置 |
|---|---|---|
| 加密內容 | AES-256-GCM sender key + DataChannel DTLS，Firestore 只見密文 | `crypto/SenderKeyManager` · ADR-0004 |
| 金流冒領 Pro | HMAC-SHA256 + 先比長度再 timingSafeEqual（constant-time） | `netlify/functions/_lib/webhook-core.ts` |
| 竄改他人公鑰 MITM | rules 只准動 `meshIdentities[auth.uid]` | firestore.rules `meshIdentitiesChangeIsValid` |
| 爬所有房 signal 建圖 | signal 讀取鎖定房間參與者/房主 | firestore.rules signals `allow read` |
| 匿名洗版建房 | create 要求 `sign_in_provider != anonymous` | firestore.rules p2pRooms `allow create` |
| 假冒他人送訊息 | message/signal `from == auth.uid` + ±30s replay 窗 | firestore.rules 子集合 |

## 弱點（按 AI 可利用性排序）

### 🔴 F1 — 無「每人房間數上限」：大量建房 DoS / 成本攻擊
rules 只限單房人數 ≤5（`participantsWithinCap`），未限單帳號建房數。
非匿名帳號（AI 自動註冊）可刷海量房間 → Firestore 寫入成本 + 洗爆公開列表。
房主心跳 + TTL 只解殭屍房**清理**，不擋**建立速率**。
- **緩解**：rules 加 rooms-per-owner 上限（需查詢或計數欄位），或 App Check +
  Firebase 端速率限制。**此項需改 firestore.rules**。

### 🟠 F2 — 社群 TURN metadata 信任（P1 新引入面）
惡意 TURN 混入 `community-turn.json` 可見 IP + 時間 metadata（內容仍受 DTLS
保護，看不到）。健康探測（relay-only）只驗活性不驗誠實。AI 可自動產生
看似合理的登錄 PR。
- **緩解**：(a) 社群 TURN 降為次選優先級（直連/自營 TURN 失敗才用）；
  (b) 登錄檔標信任等級 + PR 需維護者核准（git 審計已在）；
  (c) 文件已警示貢獻者 credential 公開風險（docs/COMMUNITY-TURN.md）。

### 🟠 F3 — P2P 無伺服器權威：遊戲作弊無法根治（架構固有）
無裁判。state-hash 抽驗（GameStateValidator）擋 casual 作弊，擋不住 AI bot
竄改自身 client 狀態。ADR-0015 已載明能力邊界。
- **緩解**：定位在「朋友間 casual」；競技級需權威伺服器（非本架構目標）。

### 🟡 F4 — E2EE 下 metadata 圖譜外洩
公開房參與者可讀 → 社交圖；房間成員/時間/密文長度皆漏。
- **緩解**：MessagePadding（256B 分塊，dormant 未接）；最小化公開 metadata。

### 🟡 F5 — 首次金鑰交換 TOFU，無驗證 UI
rules 擋 Firestore 端覆寫公鑰（強），但首次接觸無 safety-number 供人工核對。
實務風險低（星型直連），但缺 defense-in-depth。
- **緩解**：加公鑰指紋顯示 / safety-number 比對 UI（Signal 式）。

### 🟡 F6 — 前端 entitlement 可繞
`usePlan` 僅 UI 門。只靠前端擋的 Pro 權益開 devtools 即破。
- **緩解**：確認耗資源的 Pro 功能由 rules/plan claim 伺服器端強制（審計清單）。

### 🟡 F7 — 相依供應鏈
AI 加速掃 cobe/firebase 等 CVE。
- **緩解**：Dependabot + lockfile 審查 + 最小相依（cobe 僅 32K 已符合）。

## 一句話結論

> 密碼學與 rules 核心是硬的；**AI 會去找 F1 這種邏輯缺口**（建房無上限）
> 與 F2 這種新引入的信任面。優先補 F1（改 rules）與 F2（社群 TURN 降級）。
> F3/F4 是架構固有，用「casual 定位 + 誠實文件」承接，不是漏洞是取捨。
