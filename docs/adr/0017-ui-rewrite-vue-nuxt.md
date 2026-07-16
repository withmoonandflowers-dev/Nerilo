# ADR-0017：UI 層重寫為 Vue 3 + Nuxt，推翻 ADR-0016

- 狀態：Accepted（2026-07-04 產品負責人拍板）
- 日期：2026-07-04
- 取代：[ADR-0016](0016-ui-theming-not-framework-swap.md)（同日稍早的「不換框架」決策）

## Context

ADR-0016 以多主題設計系統（五組調色盤＋動效）回應視覺不滿，當日完成上線。
產品負責人看過成果後仍判定不合格，並在完整的 goal 分析
（換框架對視覺目標貢獻為零、成本與風險在 E2E 與付費閉環）之後，
仍拍板換框架＋UI 打掉重做。此為產品負責人的審美與策略決策，予以記錄執行。

本次與 ADR-0016 的差異：這次先釘死了視覺目標參照物——
**iMessage / Telegram 風：亮色底、大圓角氣泡、活潑彈性動效的消費級通訊感**。
上一輪失敗的根因即是無具體參照物。

## Decision

1. **框架**：UI 層改用 Vue 3 + Nuxt（SPA 模式 `ssr: false`，因 Firebase Auth
   與 WebRTC 均為純瀏覽器 API，SSR 無收益只有成本）。
2. **範圍**：只重寫 UI 層（pages / components / contexts / hooks）。
   核心 30K LOC（core/p2p、mesh、crypto、relay）為框架無關純 TS，直接複用；
   services（RoomService 等）與 types 同樣複用。
3. **並存過渡**：新 app 建在 repo 內 `web-vue/`，與現有 React app 並存。
   Firebase Hosting 切換目標前，React 版維持 production，付費閉環不中斷。
4. **視覺契約**：以 iMessage/Telegram 為參照的設計規格見
   [UI-REDESIGN-SPEC.md](../UI-REDESIGN-SPEC.md)，實作不得偏離參照物方向。

### Production 切換門檻（2026-07-16 補充）

以下全部成立才可把 Firebase Hosting 從 React `dist/` 切到 Nuxt `.output/public`：

1. `vue-quality`（`nuxt typecheck` + `nuxt generate`）是 PR／master 硬閘且持續為綠。
2. `@vue-stable` emulator E2E 自 2026-07-16 起連續兩週綠；2026-07-30 後先移除
   `continue-on-error` 變硬閘，再談切換。
3. Vue 既有 E2E 涵蓋註冊、建房、加入、雙向恰好一次、E2EE、重進、好友、房間管理、
   persistent rooms、遊戲與信使欠條；`@vue-stable` 九條旅程與尚待正式環境驗證項目
   以 [Vue parity matrix](../VUE-PARITY.md) 追蹤，所有 P0/P1 失敗清零。
4. 對 Vue build 重跑 production smoke：直連、強制 TURN、誠實 fallback 三條全綠。
5. 產品負責人完成視覺驗收；部署變更保留上一個 React artifact／commit，可一鍵回退。

在第 2 至 5 點完成前，Vue CI 只證明「接班版沒有持續腐壞」，不代表已授權切 production。

## Consequences

- 接受成本：Playwright E2E（@stable 10/10）綁定舊 DOM，切換後需改寫 selector
  並重新驗證付費徽章、smoke test——這是本決策的已知代價。
- React 版凍結新功能，只修 production 緊急問題，避免雙軌發散。
- CLAUDE.md 的技術棧描述需在切換時更新（現況描述本已與事實不符：
  寫著 Tailwind + shadcn/ui，實際是手寫 CSS）。
- 若 Vue 版在驗收時仍不合產品負責人審美，問題確定不在框架層，
  下一輪只能動設計參照物本身，不再動框架（此為兩次 ADR 的共同教訓）。
