# UX Design Tokens - 統一視覺設計系統

你的任務是為 Nerilo 建立 CSS Design Tokens 系統，統一所有頁面的視覺風格並支援 dark mode。

## 專案背景
Nerilo 使用純 CSS，目前各頁面的顏色、間距、圓角等都是 hardcoded 值，缺乏一致性。

## 執行步驟

### Step 1：盤點現有設計值
讀取所有 CSS 檔案，收集現有的設計值：
- `src/pages/LoginPage.css`
- `src/pages/DashboardPage.css`
- `src/pages/WaitingRoomPage.css`
- `src/features/chat/ChatPage.css`
- `src/index.css`

記錄所有使用的：顏色值、字體大小、間距值、圓角值、陰影值、漸層值

### Step 2：建立 CSS Variables
建立 `src/styles/variables.css`：

```css
:root {
  /* Primary Colors */
  --color-primary: #667eea;
  --color-primary-dark: #5a6fd6;
  --color-primary-light: #8b9cf0;
  --color-secondary: #764ba2;

  /* Semantic Colors */
  --color-success: #4caf50;
  --color-warning: #ff9800;
  --color-error: #f44336;
  --color-info: #2196f3;

  /* Neutral Colors */
  --color-bg: #ffffff;
  --color-bg-secondary: #f5f5f5;
  --color-bg-tertiary: #eeeeee;
  --color-text: #333333;
  --color-text-secondary: #666666;
  --color-text-muted: #999999;
  --color-border: #e0e0e0;

  /* Spacing */
  --spacing-xs: 4px;
  --spacing-sm: 8px;
  --spacing-md: 16px;
  --spacing-lg: 24px;
  --spacing-xl: 32px;
  --spacing-xxl: 48px;

  /* Border Radius */
  --radius-sm: 4px;
  --radius-md: 8px;
  --radius-lg: 12px;
  --radius-xl: 16px;
  --radius-full: 9999px;

  /* Shadows */
  --shadow-sm: 0 1px 3px rgba(0, 0, 0, 0.1);
  --shadow-md: 0 4px 6px rgba(0, 0, 0, 0.1);
  --shadow-lg: 0 10px 25px rgba(0, 0, 0, 0.15);

  /* Typography */
  --font-size-xs: 12px;
  --font-size-sm: 14px;
  --font-size-md: 16px;
  --font-size-lg: 18px;
  --font-size-xl: 24px;
  --font-size-xxl: 32px;

  /* Gradients */
  --gradient-primary: linear-gradient(135deg, var(--color-primary) 0%, var(--color-secondary) 100%);

  /* Transitions */
  --transition-fast: 150ms ease;
  --transition-normal: 300ms ease;
}
```

**重要：** 以上只是起始模板，要根據 Step 1 盤點的實際值來調整，確保替換後外觀不變。

### Step 3：Dark Mode
在 `variables.css` 中加入：

```css
@media (prefers-color-scheme: dark) {
  :root {
    --color-bg: #1a1a2e;
    --color-bg-secondary: #16213e;
    --color-bg-tertiary: #0f3460;
    --color-text: #e0e0e0;
    --color-text-secondary: #b0b0b0;
    --color-text-muted: #808080;
    --color-border: #333355;
    --shadow-sm: 0 1px 3px rgba(0, 0, 0, 0.3);
    --shadow-md: 0 4px 6px rgba(0, 0, 0, 0.3);
    --shadow-lg: 0 10px 25px rgba(0, 0, 0, 0.4);
  }
}
```

### Step 4：替換 Hardcoded 值
逐檔替換所有 CSS 中的 hardcoded 值為 CSS variables：
- 顏色 → `var(--color-xxx)`
- 間距 → `var(--spacing-xxx)`
- 圓角 → `var(--radius-xxx)`
- 陰影 → `var(--shadow-xxx)`
- 字體大小 → `var(--font-size-xxx)`

### Step 5：引入 variables.css
在 `src/index.css` 或 `src/main.tsx` 頂部引入 `variables.css`，確保全域生效。

## 限制
- Light mode 下的外觀必須和替換前完全一致
- 不改變任何 HTML 結構或 React 邏輯
- 只處理 CSS 層面的改動
- Dark mode 不需要完美，只需要基本可用（不刺眼、文字可讀）
