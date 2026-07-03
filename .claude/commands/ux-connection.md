# UX Connection - 改善 P2P 連線狀態體驗

你的任務是改善 Nerilo 的 P2P 連線狀態 UX，讓使用者清楚知道目前的連線模式和狀態。

## 專案背景
Nerilo 是 P2P 優先的聊天平台，有三種連線模式：
1. **P2P 直連**（Star topology，2 人）
2. **Mesh 中繼**（Mesh topology，3+ 人）
3. **Firestore 備援**（P2P 失敗時的 fallback）

目前 ChatPage 有簡單的 connection hint，但不夠清晰持久。

## 執行步驟

### Step 1：先了解現有架構
讀取以下檔案了解連線狀態的資料流：
- `src/features/chat/ChatPage.tsx` — 現有連線狀態 UI
- `src/features/chat/hooks/useStarTopology.ts` — Star 模式 hook
- `src/features/chat/hooks/useMeshTopology.ts` — Mesh 模式 hook
- `src/core/p2p/P2PConnectionManager.ts` — P2P 連線管理
- `src/components/ConnectionStatusPanel.tsx` — 現有狀態面板

### Step 2：建立 ConnectionBanner 元件
建立 `src/components/ConnectionBanner/ConnectionBanner.tsx` 和 `ConnectionBanner.css`：

**功能需求：**
- 頁面頂部持久性橫幅（不會自動消失）
- 根據狀態顯示不同的樣式：
  - 🟢 **P2P 已連線**：綠色底，「P2P 直連中 — 訊息端對端傳輸」
  - 🔵 **Mesh 已連線**：藍色底，「Mesh 網路連線中 — N 位成員」
  - 🟡 **連線中**：黃色底，「正在建立 P2P 連線...」+ 載入動畫
  - 🔴 **已斷線**：紅色底，「連線已中斷」+ 重連倒數 + 手動重連按鈕
  - 🟣 **備援模式**：紫色底，「使用雲端備援通道 — 訊息經由伺服器傳輸」
- 點擊可展開/收合詳細資訊（延遲、拓撲類型、連線品質）
- 橫幅高度收合時盡量小（約 32-40px），不佔太多聊天空間

**Props 設計：**
```typescript
interface ConnectionBannerProps {
  mode: 'p2p' | 'mesh' | 'firestore' | 'connecting' | 'disconnected';
  peerCount?: number;
  latency?: number;
  onReconnect?: () => void;
}
```

### Step 3：整合到 ChatPage
- 替換現有的 connection hint 區塊
- 從現有 hooks 取得連線狀態資訊傳入 ConnectionBanner
- 確保狀態變化時有平滑過渡動畫

### Step 4：WaitingRoomPage 簡化版
在 WaitingRoomPage 加入簡化版連線狀態指示：
- 只顯示「等待連線...」/「已就緒」兩種狀態
- 用小圓點 + 文字表示，不需要完整橫幅

## 限制
- 保持現有功能不變，只改善 UI 呈現
- 不修改 P2P 連線邏輯本身
- 使用純 CSS，不安裝新套件
