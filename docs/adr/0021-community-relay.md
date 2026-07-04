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

## 分階段與進度

| 階段 | 內容 | 狀態 |
|---|---|---|
| P2.0 | 中繼→點數 glue（recordRelayContribution）+ App Check 擋機器人 | ✅ 完成 |
| P2.1 | **發現層**：RelayDirectory（announce/query/TTL）+ RelayOverlay（發現→registerPeer）| ✅ 完成 |
| P2.2 | **端到端邏輯證明**：記憶體多節點模擬 A→C→B（發現→中繼→送達→C 賺點）| ✅ 完成（RelayOverlaySim.spec） |
| P2.3 | **整合入口**：RelayCoordinator.useOverlay 組裝 directory+overlay+credit+transport | ✅ 完成 |
| P2.D | **部署接縫**（見下）：Firestore 目錄 adapter + 真 WebRTC transport + rules + 真實多節點測試 | ⏳ 待部署 |

### 已完成：overlay 邏輯 + 端到端模擬證明

routing 大腦（RelayManager）之外，補齊了它缺的「網路名冊」與「發現」，並用
**記憶體多節點模擬**證明整條邏輯通：A 經目錄發現 C → registerPeer → sendViaRelay
→ C 中繼轉發 → B 送達 → C 賺點。這是「路由 + 發現 + 計費」邏輯的端到端證明。

### 待部署（P2.D）：只剩「換上真實傳輸與名冊」

模擬用 `InMemoryRelayDirectory` + `SimTransport`；上 production 只需替換兩個注入點，
邏輯不變：

1. **Firestore 目錄 adapter**（`IRelayDirectory` 的 Firestore 實作）——跨房發現。
   **需 firestore.rules 新增 relayNodes 集合規則**（非匿名 + 速率限制防女巫灌假節點）。
   rules 目前平行 session 維護中，故此 adapter 待協調後補。
2. **真 WebRTC transport**（`RelayCoordinator.attachTransport` 注入實際 peerSend）——
   連上房間外的中繼節點需新 signaling 路徑。
3. **真實多節點驗證**：3+ 真實瀏覽器節點跑 A→C→B + 評分踢除 + 女巫抵抗。

**觸發條件**：P2.D 投入前先看 P0 數據——直連成功率高、TURN 不痛時可緩；數據說痛了再上。
邏輯已就緒且證明可用，屆時是「接真實傳輸」而非「從頭寫」。

## Consequences

- **好處**：機器（relay/ 模組）已備齊，接線即得省成本 + 救連線；中繼產生點數的
  誘因層本回合就位，讓「在線貢獻」有回饋。
- **成本/風險**：P2.1+ 需真實多 peer 拓撲與測試，非單元測試可完全覆蓋；中繼增加
  延遲（casual 可接受，寫入能力邊界）。
- **已交付（本回合）**：`recordRelayContribution` + 測試、App Check（`config/appCheck.ts`
  + main.tsx 接線，env-gated）。
