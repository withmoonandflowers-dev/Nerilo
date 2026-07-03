# UX Message Status - 訊息傳送狀態指示

你的任務是為 Nerilo 的聊天訊息加入傳送狀態指示，讓使用者知道訊息是否成功送達。

## 專案背景
Nerilo 使用 WebRTC P2P 傳送聊天訊息，目前送出訊息後沒有任何傳送狀態回饋。

## 執行步驟

### Step 1：了解現有訊息架構
先讀取以下檔案：
- `src/types/index.ts` — 現有 Message 類型定義
- `src/features/chat/ChatService.ts` — 訊息傳送邏輯
- `src/features/chat/ChatPage.tsx` — 訊息渲染 UI
- `src/features/chat/hooks/useChatMessages.ts` — 訊息狀態管理

### Step 2：擴充 Message 類型
在 Message 類型中加入：
```typescript
deliveryStatus?: 'sending' | 'sent' | 'delivered' | 'failed';
```
使用 optional 以保持向後相容。

### Step 3：修改訊息傳送流程
在 ChatService 中：
1. 送出訊息時，先將 `deliveryStatus` 設為 `'sending'`
2. P2P DataChannel 確認送出後，改為 `'sent'`
3. 收到對方的 delivery acknowledgment 後，改為 `'delivered'`
4. 傳送失敗（timeout 或 error）時，改為 `'failed'`

如果現有架構沒有 acknowledgment 機制，至少實作 sending → sent 的轉換，delivered 可以先跳過。

### Step 4：修改訊息氣泡 UI
在 ChatPage 的自己發送的訊息氣泡右下角顯示狀態：
- `sending`：灰色小時鐘「⏳」
- `sent`：灰色單勾「✓」
- `delivered`：藍色雙勾「✓✓」
- `failed`：紅色驚嘆號「⚠」+ 可點擊的「重新傳送」文字按鈕

**CSS 樣式：**
- 狀態圖示字體要小（12px），位於訊息氣泡右下角
- 和時間戳放在同一行
- failed 狀態的「重新傳送」要明顯可點擊（underline + pointer cursor）

### Step 5：重送機制
當使用者點擊「重新傳送」時：
1. 將狀態改回 `'sending'`
2. 重新呼叫訊息傳送邏輯
3. 如果再次失敗，恢復 `'failed'` 狀態

## 限制
- 只修改必要的檔案
- 不改變現有訊息的資料結構（只新增 optional field）
- 對方發送的訊息不顯示狀態（只顯示自己的）
- 保持現有功能不變
