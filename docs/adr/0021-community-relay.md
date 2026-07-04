# ADR-0021：社群中繼——效能、安全、與「中繼即價值」

- 狀態：Accepted（方向）／實作分階段
- 日期：2026-07-04
- 相關：ADR-0011（過路點數）、ADR-0012（社群中繼基礎）、ADR-0020（點數經濟）

## Context

產品負責人拍板：**做社群中繼**（含效能與安全），且**中繼要能「產生價值」（點數）**
——怎麼兌換由上層/玩家決定，Nerilo 只負責產生。定位：Nerilo 是資料傳遞基礎架構，
中繼讓「多人在線 = 網路更好、更省」成真（P2P 直連失敗時，第三個在線 peer 幫忙轉，
省 TURN 成本）。

資產盤點：relay/ 模組群已建且測過（dormant）——RelayManager（sendViaRelay /
handleRelayPacket，Sphinx 洋蔥轉發）、PeerScoring（行為評分 + graylist/disconnect
閾值）、RelayScorer（延遲/可靠/頻寬/uptime/多樣性排名）、MultiPathSelector（多獨立路徑）、
RateLimiter、MessagePadding。缺的不是機器，是**接進活的連線流 + 接上點數**。

## Decision

### 效能（怎麼選好中繼）

- **RelayScorer** 排名候選節點（0.35 延遲 + 0.25 可靠 + 0.20 頻寬 + 0.10 uptime +
  0.10 多樣性），選最高分。
- **MultiPathSelector**：重要流量走 2–4 條獨立路徑，避免單點慢/斷（後期）。
- **只在直連失敗時才中繼**：直連成功的配對已是最短路徑，中繼幫不上——用 P0 量測
  （ConnectionStats）判斷何時直連失敗率高到值得。中繼是省成本/救連線，不是預設路徑。

### 安全（惡意中繼怎麼防）

- **窺探**：轉發內容已 E2EE（sender key），中繼 peer 看不到明文；Sphinx 洋蔥
  再隱藏路由。MessagePadding 防大小分析。中繼看得到的只有加密 blob + 時間 metadata。
- **丟包/搗亂**：PeerScoring 記 delivery/failure/duplicate，低於 graylist 閾值即
  停止採用、低於 disconnect 即斷。
- **灌流量/放大攻擊**：RateLimiter 每 peer + 全域滑動窗上限。
- **刷點**：見下——中繼點數走既有每小時上限節流；真實雙簽收據待 Phase 2。

### 中繼即價值（點數產生，本回合已接）

- 本機成功為他人轉發 N bytes → `creditEconomy.recordRelayContribution(requester, bytes)`
  依 perKbRelayed + perRelayBonus 產生點數，走 LocalCreditProvider 每小時上限防刷。
- **Nerilo 只產生點數，不做兌換**：兌換成真實好處由上層/玩家決定（範圍外，
  避免類金融/防詐負擔——見 threat-model）。
- Phase 1 本機記帳（proof='local'）；Phase 2 換真實雙簽收據 / 伺服器權威帳本時
  IIncentiveProvider 介面不變。

## 分階段（誠實：#1 是多 session 大工程）

| 階段 | 內容 | 狀態 |
|---|---|---|
| P2.0 | 中繼→點數 glue（recordRelayContribution）+ App Check 擋機器人 | ✅ 本回合 |
| P2.1 | RelayManager 接活連線流：注入 peerSendFn（真 WebRTC 送）、餵 RelayScorer 候選、直連失敗才觸發 | ⏳ 下階段 |
| P2.2 | 1-hop 中繼端到端（第三 peer 轉發 A↔B）+ 中繼成功呼叫 recordRelayContribution | ⏳ |
| P2.3 | 多路徑（MultiPathSelector）+ PeerScoring/RateLimiter 全面接線 | ⏳ |
| P2.4 | 多 peer 真實網路壓測 + 數據回饋 | ⏳ |

**觸發條件**：P2.1 起，先看 P0 數據——直連成功率高、TURN 不痛時可緩；數據說痛了全推。

## Consequences

- **好處**：機器（relay/ 模組）已備齊，接線即得省成本 + 救連線；中繼產生點數的
  誘因層本回合就位，讓「在線貢獻」有回饋。
- **成本/風險**：P2.1+ 需真實多 peer 拓撲與測試，非單元測試可完全覆蓋；中繼增加
  延遲（casual 可接受，寫入能力邊界）。
- **已交付（本回合）**：`recordRelayContribution` + 測試、App Check（`config/appCheck.ts`
  + main.tsx 接線，env-gated）。
