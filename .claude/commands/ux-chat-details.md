# UX Chat Details - 聊天頁面互動細節改善

你的任務是改善 Nerilo 聊天頁面的互動細節，提升即時通訊體驗。

## 專案背景
Nerilo 使用 WebRTC P2P DataChannel 傳送聊天訊息，目前缺少打字指示、時間格式化等聊天 app 常見功能。

## 執行步驟

### Step 1：了解現有架構
先讀取以下檔案：
- `src/features/chat/ChatPage.tsx` — 聊天 UI
- `src/features/chat/ChatService.ts` — 訊息傳送
- `src/features/chat/hooks/useChatMessages.ts` — 訊息管理
- `src/core/p2p/P2PConnectionManager.ts` — DataChannel 操作

### Step 2：打字指示器（Typing Indicator）
1. 定義 typing 事件格式，透過 P2P DataChannel 傳送：
   ```typescript
   { type: 'typing', from: userId, isTyping: boolean }
   ```
2. 在 ChatPage 的輸入框 `onChange` 事件中：
   - 開始輸入時發送 `isTyping: true`
   - 使用 debounce（300ms），停止輸入後發送 `isTyping: false`
   - 設定 timeout（3 秒），超時自動發送 `isTyping: false`
3. 在訊息列表底部顯示打字指示動畫：
   - 「{使用者名稱} 正在輸入...」
   - 三個跳動的點動畫（CSS animation）

### Step 3：時間戳格式化
建立一個 `formatMessageTime(timestamp: number)` 工具函式：
- **今天**的訊息：顯示 `HH:mm`（例如「14:30」）
- **昨天**的訊息：顯示 `昨天 HH:mm`
- **本週內**的訊息：顯示 `週X HH:mm`
- **更早**的訊息：顯示 `MM/DD HH:mm`

在 ChatPage 中使用此函式格式化所有訊息的時間戳。

### Step 4：新訊息提示
當使用者捲動到上方（不在底部）時，如果收到新訊息：
1. 在訊息區域底部顯示一個浮動按鈕：「↓ N 則新訊息」
2. 點擊按鈕後捲動到最新訊息
3. 當使用者自己捲動到底部時，按鈕自動消失
4. 按鈕要有明顯的視覺提示（例如 primary 色背景、圓角、陰影）

### Step 5：鍵盤送出快捷鍵
修改 ChatPage 的 textarea：
- **Enter**：送出訊息
- **Shift + Enter**：換行
- 確保在 mobile 上 Enter 也是送出（不是換行）
- 空白訊息不可送出（disable send button + 阻止 Enter 送出）

## 限制
- 只修改 ChatPage 相關檔案和必要的 service 層
- 不安裝新套件
- 打字指示器的 P2P 事件要輕量，不能影響正常訊息傳送效能
- 保持現有功能不變
