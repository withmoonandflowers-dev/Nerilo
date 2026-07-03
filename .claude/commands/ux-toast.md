# UX Toast - 建立 Toast 通知系統

你的任務是為 Nerilo 專案建立一個輕量的 Toast 通知元件，取代所有 browser `alert()`。

## 專案背景
Nerilo 是 React 18 + TypeScript 專案，使用純 CSS，不安裝任何 UI 框架。

## 執行步驟

### Step 1：建立 Toast 元件
建立 `src/components/Toast/Toast.tsx` 和 `src/components/Toast/Toast.css`：

**功能需求：**
- 支援 4 種類型：`success`（綠色）、`error`（紅色）、`warning`（橘色）、`info`（藍色）
- 每個 toast 預設 3 秒後自動消失
- 右上角有 X 按鈕可手動關閉
- 從畫面右上角滑入，支援堆疊顯示（多個 toast 垂直排列）
- 使用 CSS `@keyframes` 實作滑入/滑出動畫
- 每個類型用不同的圖示前綴（可用 unicode：success ✓、error ✕、warning ⚠、info ℹ）

**CSS 動畫：**
```css
@keyframes slideIn {
  from { transform: translateX(100%); opacity: 0; }
  to { transform: translateX(0); opacity: 1; }
}
@keyframes slideOut {
  from { transform: translateX(0); opacity: 1; }
  to { transform: translateX(100%); opacity: 0; }
}
```

### Step 2：建立 ToastContext
檢查是否已存在 `src/contexts/ToastContext.tsx`，如果有就在其基礎上修改，如果沒有就新建。

提供 `useToast()` hook，API 設計：
```typescript
const toast = useToast();
toast.success('房間建立成功！');
toast.error('連線失敗，請重試');
toast.warning('連線不穩定');
toast.info('新成員已加入');
```

### Step 3：整合到 App
在 `src/App.tsx` 中加入 `<ToastProvider>`，包裹在路由外層。

### Step 4：替換所有 alert()
搜尋 `src/` 目錄中所有 `alert(` 呼叫：
- 根據上下文判斷應該用哪種 toast 類型
- 成功操作 → `toast.success()`
- 錯誤/失敗 → `toast.error()`
- 警告/提醒 → `toast.warning()`
- 一般資訊 → `toast.info()`

### Step 5：改善 catch 區塊
搜尋所有 `catch` 區塊，確保使用者可見的錯誤都透過 toast 顯示，而不是只有 `console.error`。

## 限制
- 不安裝任何新的 npm 套件
- 純 CSS 實作所有動畫效果
- 保持現有功能不變
- Toast 容器的 z-index 要足夠高（建議 9999）
