# UX Share - 改善房間分享功能

你的任務是改善 Nerilo 的房間邀請與分享體驗。

## 專案背景
Nerilo 目前只有「複製連結」一種分享方式，沒有 QR Code 或系統分享功能。

## 執行步驟

### Step 1：了解現有分享機制
讀取以下檔案：
- `src/pages/WaitingRoomPage.tsx` — 現有的分享/複製連結邏輯
- `src/pages/DashboardPage.tsx` — 房間列表
- `src/services/RoomService.ts` — 房間資訊

### Step 2：建立 ShareModal 元件
建立 `src/components/ShareModal/ShareModal.tsx` 和 `ShareModal.css`：

**功能需求：**
- Modal overlay（點擊背景關閉）
- 房間連結顯示 + 一鍵複製按鈕
- QR Code 顯示（使用 `qrcode` npm 套件產生，需要安裝）
- Web Share API 按鈕（`navigator.share`），不支援時隱藏
- 複製成功後透過 toast 提示（依賴 /ux-toast 建立的 ToastContext，如果尚未建立，使用簡單的 inline 提示）

**Props：**
```typescript
interface ShareModalProps {
  isOpen: boolean;
  onClose: () => void;
  roomId: string;
  roomName: string;
}
```

**佈局：**
```
┌─────────────────────────┐
│  分享房間「XXX」     ✕  │
│                         │
│  ┌─────────────────┐    │
│  │   [QR Code]     │    │
│  │    200x200      │    │
│  └─────────────────┘    │
│                         │
│  🔗 https://...  [複製] │
│                         │
│  [📤 分享到其他應用]     │
└─────────────────────────┘
```

### Step 3：安裝 QR Code 套件
```bash
npm install qrcode @types/qrcode
```
使用 `QRCode.toCanvas()` 或 `QRCode.toDataURL()` 產生 QR Code。

### Step 4：整合到頁面
- **WaitingRoomPage**：將現有的「複製連結」按鈕改為開啟 ShareModal
- **DashboardPage**：在每個房間卡片上加一個分享圖示按鈕（📤 或 🔗）

### Step 5：連結格式
保持現有的連結格式（`{origin}/waiting/{roomId}`），不做修改。
連結文字可以帶上房間名稱：「加入 Nerilo 房間『{roomName}』」

## 限制
- 保持現有連結格式不變
- QR Code 是唯一需要安裝的新套件
- Modal 要有適當的 escape 鍵關閉和 focus trap
