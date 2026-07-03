# UX Responsive - 全面 Mobile Responsive 支援

你的任務是讓 Nerilo 所有頁面都完整支援 mobile responsive。

## 專案背景
Nerilo 使用純 CSS，目前只有 WaitingRoomPage 有部分 responsive 支援，其他頁面在手機上可能顯示異常。

## 執行步驟

### Step 1：確認 viewport meta tag
檢查 `index.html`，確認有：
```html
<meta name="viewport" content="width=device-width, initial-scale=1.0">
```
如果沒有就加上。

### Step 2：逐頁修改 CSS

#### LoginPage.css
讀取 `src/pages/LoginPage.tsx` 和 `src/pages/LoginPage.css`，加入：
- 表單容器在小螢幕（≤480px）寬度改為 `width: 90%`（不是 hardcoded px）
- 按鈕在小螢幕改為 `width: 100%`
- Google 登入按鈕圖示和文字在小螢幕正確排列
- 字體大小適配（標題不小於 20px，內文不小於 14px）

#### DashboardPage.css
讀取 `src/pages/DashboardPage.tsx` 和 `src/pages/DashboardPage.css`，加入：
- 卡片 grid 在 ≤768px 改為單欄
- 建立房間表單在小螢幕改為全寬 stack layout
- Header 的使用者資訊和登出按鈕在小螢幕改為垂直排列或 hamburger 樣式
- Features grid 在小螢幕改為單欄

#### ChatPage.css
讀取 `src/features/chat/ChatPage.tsx` 和 `src/features/chat/ChatPage.css`，加入：
- 訊息區域佔滿可用高度（使用 `dvh` 或 `calc(100vh - header - input)`）
- 輸入框固定在底部
- Header 精簡化：在小螢幕隱藏非必要資訊
- 訊息氣泡最大寬度在小螢幕改為 85%（而非 70%）

#### WaitingRoomPage.css
讀取 `src/pages/WaitingRoomPage.tsx` 和 `src/pages/WaitingRoomPage.css`，確認：
- 現有 responsive 是否完整
- 補足缺失的斷點

### Step 3：Textarea 自動增高
修改 ChatPage 的訊息輸入 textarea：
- 預設 1 行高
- 隨輸入內容自動增高，最多 4 行
- 超過 4 行出現捲軸
- 送出後重設為 1 行

### Step 4：觸控目標優化
檢查所有互動元素（按鈕、連結、checkbox）：
- 確保最小觸控目標 44x44px（包含 padding）
- 按鈕間距至少 8px，避免誤觸

### Step 5：測試斷點
確認以下斷點都有合理的顯示效果：
- 320px（小型手機，如 iPhone SE）
- 375px（標準手機，如 iPhone 12）
- 768px（平板直向）
- 1024px（平板橫向/小筆電）

使用一致的 media query 斷點命名：
```css
/* Mobile */
@media (max-width: 480px) { }
/* Tablet */
@media (max-width: 768px) { }
/* Small Desktop */
@media (max-width: 1024px) { }
```

## 限制
- 不改變桌面版的現有外觀
- 只新增 media queries 和必要的 CSS 調整
- 不安裝任何新套件
- 不修改 component 邏輯（除了 textarea 自動增高）
