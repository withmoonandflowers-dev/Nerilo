# UX Audit - Nerilo 專案 UX 診斷評估

你是 Nerilo 專案的 UX 審計專家。Nerilo 是一個 React 18 + TypeScript + Firebase + WebRTC P2P 即時聊天平台，使用純 CSS（無 UI 框架）。

## 任務

對整個專案進行全面的 UX 診斷評估，**不修改任何程式碼**，只產出分析報告。

## 執行步驟

### 1. 頁面盤點
逐一讀取以下頁面，分析每頁的 UX 問題：
- `src/pages/LoginPage.tsx` + `src/pages/LoginPage.css`
- `src/pages/DashboardPage.tsx` + `src/pages/DashboardPage.css`
- `src/pages/WaitingRoomPage.tsx` + `src/pages/WaitingRoomPage.css`
- `src/features/chat/ChatPage.tsx` + `src/features/chat/ChatPage.css`

對每個問題標記嚴重度：
- **P0 阻斷**：功能無法使用、資料遺失風險
- **P1 嚴重**：嚴重影響使用體驗、使用者容易困惑
- **P2 改善**：可用但體驗不佳、缺少預期功能
- **P3 美化**：視覺細節、微互動、錦上添花

### 2. Mobile Responsive 檢查
檢查所有 CSS 檔案：
- 搜尋 `@media` 查詢，確認哪些頁面有/缺少 responsive 支援
- 檢查是否有 hardcoded px 寬度可能在小螢幕溢出
- 確認 `index.html` 是否有正確的 viewport meta tag
- 檢查觸控目標大小（按鈕、連結是否至少 44x44px）

### 3. 錯誤處理審計
搜尋整個 `src/` 目錄：
- 所有 `alert()` 呼叫 — 列出位置和內容
- 所有 `catch` 區塊 — 確認是否有使用者友善的錯誤提示
- 所有 `console.error` — 確認是否只是開發者 log 還是也應該通知使用者
- 檢查網路斷線時的 fallback 行為

### 4. Loading 狀態審計
- 搜尋所有 `useState` + 非同步操作，確認是否有對應的 loading UI
- 搜尋「載入中」、「loading」等文字，評估 loading 體驗品質
- 檢查 React.lazy + Suspense 的 fallback UI
- 確認頁面初次載入時是否有空白閃爍

### 5. Accessibility (a11y) 審計
- 檢查所有 `<button>`、`<input>`、`<a>` 是否有 `aria-label` 或可見 label
- 確認表單 `<input>` 是否都有對應的 `<label>`
- 檢查顏色是否為唯一的狀態指示（例如連線狀態只用顏色區分）
- 確認是否有 `role`、`aria-live` 等語義屬性
- 檢查 tab 鍵導航是否合理

## 輸出格式

```markdown
# Nerilo UX 診斷報告

## 總覽
- P0 問題數：X
- P1 問題數：X
- P2 問題數：X
- P3 問題數：X

## P0 阻斷級問題
### [問題標題]
- **頁面**：[影響的頁面]
- **位置**：[檔案:行號]
- **問題**：[描述]
- **建議修復**：[方案]
- **對應 Skill**：/ux-xxx（建議用哪個 skill 修復）

## P1 嚴重級問題
...（同上格式）

## P2 改善級問題
...

## P3 美化級問題
...

## 建議執行順序
1. 第一步：/ux-xxx — 原因
2. 第二步：/ux-xxx — 原因
...
```

重要：每個問題都要標記「對應 Skill」，讓使用者知道執行哪個 slash command 可以修復該問題。可對應的 skills：
- `/ux-toast` — Toast 通知系統
- `/ux-connection` — 連線狀態改善
- `/ux-message-status` — 訊息傳送狀態
- `/ux-responsive` — Mobile Responsive
- `/ux-skeleton` — Loading Skeleton
- `/ux-share` — 分享功能
- `/ux-chat-details` — 聊天細節
- `/ux-design-tokens` — Design Tokens
- `/ux-a11y` — Accessibility
