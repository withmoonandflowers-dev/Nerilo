# ADR-0020：點數經濟——玩遊戲即參與基礎建設

- 狀態：Accepted（2026-07-04）
- 日期：2026-07-04
- 相關：ADR-0011（過路點數經濟）、ADR-0012（社群中繼）、ADR-0015（遊戲為第二應用）、ADR-0018/0019（遊戲傳輸）

## Context

產品負責人定調正向循環：**來玩遊戲 → 在線即貢獻網路容量 → 賺點數 →
點數在遊戲裡花**。遊戲是解 P2（社群中繼）冷啟動的「特洛伊木馬」——
沒誘因沒人願意在線中繼；遊戲給了在線的理由，玩家「不知不覺參與基礎建設」。

資產盤點：`LocalCreditProvider`（ADR-0011）已建，含防作弊節流、負債下限、
tier，但三個缺口擋住願景：(1) 只有記憶體 Map，重整即失；(2) `recordUptime`
沒人呼叫，在線不賺點；(3) 遊戲無讀/花點接口。

## Decision

新增 `CreditEconomy`（`src/core/incentive/CreditEconomy.ts`）——點數經濟骨架，
建在 LocalCreditProvider 之上，補齊三缺口：

1. **持久化**：本機單一節點餘額存 localStorage（跨 session 累積），無 localStorage
   環境退化記憶體。刻意不用 Dexie（避免 schema 遷移）。
2. **在線累積**：`startEarning/stopEarning` 每 60 秒 pro-rata 結算 `perUptimeHour`。
   ChatPage 綁 `connectionState === 'connected'`——**實際連線中**才賺（非開分頁），
   降低純掛機刷點。斷線/離開自動停。
3. **遊戲面向 facade**：`getBalance / getServiceTier / trySpend(amount, reason) /
   subscribe`。遊戲花點呼叫 `creditEconomy.trySpend(10, 'game:powerup')`，
   餘額不足回 false 不扣。UI 經 `usePlayerCredits`（React）反應式呈現；
   Vue 版平行實作（邏輯全在框架無關的 CreditEconomy）。

### 定位與紅線

- **框架無關**：純 `src/core` + 一顆 singleton，活過 ADR-0017 的 Vue 重寫
  （不建會被丟棄的 React 遊戲 UI）。
- **Phase 1 = 本機點數**：非真實貨幣、無 sybil 抵抗。**兌換真實權益前必須補防刷**
  （threat-model F-payment）。目前點數只在「本機遊戲內」有意義，風險可控。
- **遷移路徑保留**：CreditEconomy 用 IIncentiveProvider（LocalCreditProvider），
  Phase 2 換 BlockchainCreditProvider 或伺服器權威帳本時介面不變。

## 這條循環目前接到哪、還差什麼（誠實邊界）

| 環節 | 狀態 |
|---|---|
| 在線 → 賺點 | ✅ 本 ADR（連線中累積 + 持久化） |
| 點數 → 遊戲可花 | ✅ 本 ADR（trySpend facade + hook） |
| 遊戲能實際玩（state 通道接進 P2PManager + 一個遊戲 + UI） | ❌ 未做（ADR-0019 state 通道尚未接線；UI 待 Vue） |
| 在線 → **實際中繼他人流量**（真貢獻，非僅在線） | ❌ 未做（P2：PeerScoring/RelayManager 接線，大工程） |
| 點數兌換真實權益（Pro） | ❌ 未做（需先解 sybil 防刷） |
| App Check 擋機器人刷帳號/點 | ❌ 未做（需 firebase.ts + Firebase console 設定，見下） |

**目前循環是「半條」**：在線賺點 + 遊戲花點已閉環，可先讓本機/朋友間遊戲運作；
「在線=真中繼貢獻」與「點數=真價值」要等 P2 與防刷，屬後續階段。

### App Check（待使用者在 console 設定）

擋自動化機器人刷帳號/建房/刷點（威脅模型 F1 殘留的正解，非房間數上限）：
1. Firebase console → App Check → 註冊 reCAPTCHA v3（web）。
2. 程式端 `initializeAppCheck` 於 firebase 初始化後（firebase.ts，目前有平行
   session 未提交變更，需協調後再加）。
3. Firestore/Functions enforce App Check。
對真實使用者零摩擦；此為對外開放前的必要步驟，非現在急件。

## Consequences

- **好處**：點數骨架就位且持久，遊戲可即刻讀/花點；框架無關活過 Vue 重寫；
  為 P2 提供「值得中繼」的誘因層（recordRelay 已存在，接上即可獎勵真中繼）。
- **成本／風險**：Phase 1 掛機可刷在線點（已用「連線中才賺」緩解，且點數尚無
  真實價值故風險低）；兌換前必補 sybil 防刷。
- **已交付**：CreditEconomy + 持久化 + 在線累積 + facade、ChatPage 累積接線、
  usePlayerCredits hook、單元測試。
