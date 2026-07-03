# ADR-0016：視覺升級用多主題設計系統，不換前端框架

- 狀態：Accepted（2026-07-04 產品負責人拍板）
- 日期：2026-07-04

## Context

產品負責人反映 UI「蠻卡的」，希望重新設計為更精緻、女生喜歡的風格，
旁邊有調色盤可選風格，並詢問是否該換前端框架以求「效能好、視覺好」。

盤點現況：
- 設計系統已 token 化：variables.css 定義完整的色彩/圓角/陰影 CSS 變數，
  所有組件皆用 var(--color-*)，且已有 dark mode。
- 效能事實：production smoke test 顯示直連 RTT 1ms、訊息往返約 96ms。
  「卡」不是網路或框架效能，是缺少過渡動效與微互動的視覺順暢感。
- 核心 30K LOC（P2P、mesh、crypto、E2EE）是框架無關的純 TypeScript，
  但整個 UI 層（pages/components/contexts/hooks）綁定 React。

## Decision

**不換前端框架**，以多主題設計系統 + 動效達成視覺與可個人化目標。

理由：
1. 換框架的成本是重寫整個 UI 層 + 全部 E2E 測試 + 重新驗證剛完成的付費徽章、
   @stable、smoke test，數週工作且高風險；核心邏輯動不到，換不到對應收益。
2. 視覺好壞是設計問題（CSS / 設計系統 / 動效），效能瓶頸不在 React
   （React 18 對聊天負載綽綽有餘）。換到 Svelte/Solid 不會讓 UI 變美或聊天變快。
3. 問題在設計層，不在框架層——現有 React 18 + Vite 完全能達成
   「精緻風格 + 可切換調色盤 + 效能好 + 視覺好」。

實作：
- variables.css 重構為 data-theme 多主題：morandi（柔霧莫蘭迪，預設）/
  cream（奶油甜柔）/ lavender（薰衣草夢幻）/ forest（森林療癒）/ dark（沉靜夜幕）。
  整體圓角加大、陰影柔化、加入 transition/easing token。
- ThemeContext 寫 data-theme 到 documentElement，localStorage 持久化。
- ThemePalette 右下角浮動調色盤，色票預覽即時切換，全站因 var() 即時生效。
- index.css 加全域微互動（按鈕按壓回彈、卡片浮起、主題切換色彩平滑過渡），
  並尊重 prefers-reduced-motion。

## Consequences

- 視覺從單一藍紫工程感升級為五組精緻柔和主題，使用者可自選風格。
- 零功能風險：只動 CSS token 與新增 theme 層，@stable E2E 10/10 不回歸、
  單元測試 987 全過。付費/E2EE/smoke 皆不受影響。
- 「風格可選」成為產品功能而非寫死——避免以刻板印象決定單一美學。
- 未來新增主題只需在 variables.css 加一組 [data-theme] 與 THEMES 清單一筆。
- 框架選型此後不再反覆討論；除非出現 React 無法滿足的硬需求，維持現狀。
