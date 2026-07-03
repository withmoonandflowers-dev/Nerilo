# UX Skeleton - Loading Skeleton 狀態

你的任務是為 Nerilo 所有非同步載入加入 Skeleton loading 狀態，取代「載入中...」純文字。

## 專案背景
Nerilo 使用 React 18 + 純 CSS，目前非同步載入時只顯示「載入中...」文字或空白。

## 執行步驟

### Step 1：建立通用 Skeleton 元件
建立 `src/components/Skeleton/Skeleton.tsx` 和 `Skeleton.css`：

```typescript
interface SkeletonProps {
  variant: 'text' | 'card' | 'message' | 'circle' | 'rect';
  width?: string;
  height?: string;
  count?: number; // 重複幾個
}
```

**CSS shimmer 動畫：**
```css
.skeleton {
  background: linear-gradient(90deg, #f0f0f0 25%, #e0e0e0 50%, #f0f0f0 75%);
  background-size: 200% 100%;
  animation: shimmer 1.5s infinite;
  border-radius: 4px;
}
@keyframes shimmer {
  0% { background-position: 200% 0; }
  100% { background-position: -200% 0; }
}
```

### Step 2：DashboardPage Skeleton
讀取 `src/pages/DashboardPage.tsx`，在以下位置加入 skeleton：
- **房間列表載入中**：顯示 3 張 skeleton 卡片（和 room-card 同樣大小和佈局）
- **Features 區域載入中**：顯示 skeleton grid（2-3 個 skeleton 卡片）
- **使用者資訊載入中**：header 區域顯示 skeleton 文字

### Step 3：ChatPage Skeleton
讀取 `src/features/chat/ChatPage.tsx`，加入：
- **歷史訊息載入中**：顯示 5-6 個 skeleton 訊息氣泡（交替左右對齊模擬對話）
- **連線建立中**：顯示連線中的骨架動畫

### Step 4：WaitingRoomPage Skeleton
讀取 `src/pages/WaitingRoomPage.tsx`，加入：
- **房間資訊載入中**：標題和參與者計數顯示 skeleton

### Step 5：替換 Suspense Fallback
找到 `src/App.tsx` 中的 `<Suspense fallback={...}>`，將純文字 fallback 替換為全頁 skeleton layout。

### Step 6：替換所有「載入中...」
搜尋 `src/` 目錄中所有「載入中」文字，替換為對應的 Skeleton 元件。

## 限制
- 純 CSS 動畫，不安裝新套件
- Skeleton 形狀要接近實際內容的佈局（不是隨意的灰色方塊）
- 保持現有功能不變
