# UX A11y - Accessibility 全面改善

你的任務是全面改善 Nerilo 的無障礙 (Accessibility) 支援。

## 專案背景
Nerilo 是 React 18 + TypeScript 的 P2P 聊天平台，目前缺乏完整的 a11y 支援。

## 執行步驟

### Step 1：全面掃描
逐一讀取所有頁面和元件的 TSX 檔案：
- `src/pages/LoginPage.tsx`
- `src/pages/DashboardPage.tsx`
- `src/pages/WaitingRoomPage.tsx`
- `src/features/chat/ChatPage.tsx`
- `src/components/` 目錄下所有元件

### Step 2：Skip-to-Content 連結
在 `src/App.tsx` 中加入 skip-to-content 連結：
```html
<a href="#main-content" className="skip-to-content">跳至主要內容</a>
```
CSS：平常隱藏，focus 時顯示在頁面頂部。
在每個頁面的主內容區域加上 `id="main-content"`。

### Step 3：ARIA Labels
為所有互動元素加入適當的 aria 屬性：

**按鈕：**
- 只有圖示的按鈕必須有 `aria-label`（如關閉按鈕、送出按鈕）
- 有文字的按鈕通常不需要額外 label

**表單：**
- 所有 `<input>` 都需要對應的 `<label htmlFor="...">`
- 如果使用 placeholder 代替 label，加上 `aria-label`
- 搜尋框加上 `role="search"`

**狀態區域：**
- 聊天訊息區域加上 `aria-live="polite"` 和 `role="log"`
- Toast 通知區域加上 `aria-live="assertive"` 和 `role="alert"`
- 連線狀態區域加上 `aria-live="polite"`

**Modal/Dialog：**
- 加上 `role="dialog"` 和 `aria-modal="true"`
- 加上 `aria-labelledby` 指向標題

### Step 4：鍵盤導航
確保：
- 所有互動元素都可以用 Tab 鍵到達
- Tab 順序邏輯合理（從上到下、從左到右）
- Modal 打開時有 focus trap（Tab 不會跑到 modal 外面）
- Escape 鍵可以關閉 modal/dropdown
- Enter/Space 可以觸發按鈕

### Step 5：顏色不作為唯一指示
檢查所有用顏色表示狀態的地方：
- 連線狀態：顏色 + 圖示 + 文字（三重指示）
- 訊息傳送狀態：顏色 + 圖示
- 錯誤/成功：顏色 + 圖示 + 文字
- 表單驗證：紅色邊框 + 錯誤文字

### Step 6：Disabled 狀態
所有 disabled 按鈕和輸入框：
- 加上 `disabled` 屬性（語義）
- 加上 `aria-disabled="true"`
- CSS 要有明顯的視覺差異（opacity 或灰色）
- cursor 設為 `not-allowed`

### Step 7：語義化 HTML
檢查並修正：
- 標題層級正確（h1 → h2 → h3，不跳級）
- 列表使用 `<ul>/<li>`
- 導航使用 `<nav>`
- 主內容使用 `<main>`
- 時間使用 `<time datetime="...">`

## 輸出要求
每修改一個檔案，說明改了什麼和為什麼：
```
## 修改 LoginPage.tsx
- 加入 `aria-label="電子郵件"` 到 email input — 原因：input 沒有對應的 label 元素
- 加入 `role="form"` 到登入表單 — 原因：提供語義化表單標記
...
```

## 限制
- 不改變任何功能邏輯
- 不改變視覺外觀（除了 skip-to-content 和 focus 樣式）
- 確保加入的 a11y 屬性不會導致重複朗讀（例如按鈕已有文字就不需要 aria-label）
