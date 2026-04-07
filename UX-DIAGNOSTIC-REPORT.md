# Nerilo UX 診斷評估報告

**產出日期：** 2026-03-28
**分析範圍：** LoginPage、DashboardPage、WaitingRoomPage、ChatPage 及所有相關服務

---

## 一、問題總覽

| 優先級 | 數量 | 說明 |
|--------|------|------|
| P0 阻斷 | 4 | 阻擋核心流程或嚴重影響使用體驗 |
| P1 嚴重 | 6 | 明顯體驗缺陷，使用者會注意到 |
| P2 改善 | 7 | 可用但體驗不佳，值得改善 |
| P3 美化 | 5 | 細節打磨，提升專業感 |

---

## 二、按優先級排序的完整問題清單

### P0 — 阻斷級

#### P0-1：全站使用 browser alert() 作為通知機制
- **影響頁面：** DashboardPage (7 處)、WaitingRoomPage (3 處)
- **問題描述：** 共 10 處 `alert()` 呼叫，會阻斷 JavaScript 執行、中斷使用者操作流程，且無法客製化外觀。包括錯誤提示（「建立房間失敗」「房間已關閉」「房間不存在」）和成功通知（「連結已複製」）。
- **具體位置：**
  - DashboardPage.tsx: L75, L113, L134, L147, L158, L181, L183
  - WaitingRoomPage.tsx: L144, L153, L240
- **建議修復：** 建立 Toast 通知系統（Prompt 1），支援 success/error/warning/info 四種類型，取代所有 alert()。

#### P0-2：DashboardPage 和 ChatPage 缺乏 Mobile Responsive
- **影響頁面：** DashboardPage、ChatPage、LoginPage
- **問題描述：** 四個 CSS 檔案中，僅 WaitingRoomPage.css 有 `@media` 查詢（max-width: 600px）。其餘三個頁面在小螢幕上會出現：
  - DashboardPage：features-grid 卡片擠壓、create-room-form 水平排列溢出、header 元素重疊
  - ChatPage：訊息氣泡 max-width: 70% 在窄螢幕上過窄、輸入區域 padding 過大
  - LoginPage：已有 max-width: 400px 限制，基本可用但缺少微調
- **建議修復：** 為所有頁面加入 media queries（Prompt 4），斷點 320px/375px/768px/1024px。

#### P0-3：多處非同步錯誤被靜默吞掉
- **影響頁面：** ChatPage、全站服務層
- **問題描述：** 多處 `.catch(() => {})` 完全吞掉錯誤，使用者不知道操作失敗：
  - RoomService.ts L321, L340：leaveSession 靜默失敗
  - RoomService.ts L614：updateDoc 靜默失敗
  - ChatPage.tsx L66：心跳更新靜默失敗
  - ChatPage.tsx L297：離開房間靜默失敗
- **建議修復：** 至少加入 console.warn 記錄，關鍵操作（如離開房間）需透過 Toast 通知使用者。

#### P0-4：ChatPage P2P 連線失敗無有效恢復機制
- **影響頁面：** ChatPage
- **問題描述：** P2P 初始化失敗時（L205, L269），僅 console.error 記錄，使用者看到的 connection-status 停留在 "connecting" 或變為 "failed"，但沒有提供重連按鈕或明確的下一步指引。連線提示（connection hint）僅在 45 秒後才出現。
- **建議修復：** 建立 ConnectionBanner 元件（Prompt 2），提供即時狀態回饋和重連按鈕。

---

### P1 — 嚴重級

#### P1-1：所有載入狀態僅顯示「載入中...」純文字
- **影響頁面：** App.tsx（Suspense fallback）、DashboardPage、WaitingRoomPage
- **問題描述：** 三處載入狀態均使用 `<p>載入中...</p>` 純文字，無 skeleton UI、無動畫、無進度指示。在慢速網路下，頁面顯得空白且無回饋。
  - App.tsx L16：全站 Suspense fallback
  - DashboardPage.tsx L209：auth 載入中
  - WaitingRoomPage.tsx L171：房間資料載入
- **建議修復：** 建立 Skeleton 元件（Prompt 5），為各頁面提供對應的 skeleton 載入狀態。

#### P1-2：訊息傳送無狀態指示
- **影響頁面：** ChatPage
- **問題描述：** 使用者送出訊息後，訊息立即顯示在畫面上，但無法區分「傳送中」「已送達」「傳送失敗」。P2P 環境下傳送失敗的機率較高，使用者可能以為訊息已送達但對方實際未收到。
- **建議修復：** 加入訊息傳送狀態指示（Prompt 3），顯示 sending/sent/delivered/failed 狀態。

#### P1-3：DashboardPage 房間建立表單無載入回饋
- **影響頁面：** DashboardPage
- **問題描述：** `isCreating` state 存在但未用於顯示建立中的視覺回饋。建立按鈕在 `isCreating` 時被 disabled，但無 spinner 或文字變化，使用者不知道是否在處理中。
- **建議修復：** 建立按鈕在 isCreating 時顯示「建立中...」+ spinner。

#### P1-4：WaitingRoomPage 分享功能原始
- **影響頁面：** WaitingRoomPage
- **問題描述：** 分享房間連結僅有複製到剪貼簿功能，且成功後用 alert() 通知。缺少 QR Code、Web Share API 整合、視覺化的分享 Modal。
- **建議修復：** 建立 ShareModal 元件（Prompt 6），提供多種分享方式。

#### P1-5：ChatPage textarea 高度固定
- **影響頁面：** ChatPage
- **問題描述：** 聊天輸入框使用 `resize: none`，高度固定，輸入長訊息時體驗差。
- **建議修復：** 改為自動增高（max 4 行），在 Prompt 4 中一併處理。

#### P1-6：無 React Error Boundary
- **影響頁面：** 全站
- **問題描述：** 任何元件 render 時的 runtime error 會導致整個應用白屏。沒有 Error Boundary 來優雅地處理渲染錯誤。
- **建議修復：** 在 App.tsx 加入頂層 Error Boundary，ChatPage 加入獨立的 Error Boundary。

---

### P2 — 改善級

#### P2-1：連線狀態指示過於簡略
- **影響頁面：** ChatPage
- **問題描述：** 連線狀態僅用一個小型 badge 顯示（connecting/connected/failed/closed），使用者難以注意到。且不區分 P2P 直連、Mesh 中繼、Firestore 備援等不同連線模式。
- **建議修復：** 建立 ConnectionBanner（Prompt 2），用更醒目的方式呈現連線狀態。

#### P2-2：缺少打字指示器
- **影響頁面：** ChatPage
- **問題描述：** 無法知道對方是否正在輸入，降低即時通訊的互動感。
- **建議修復：** 透過 P2P DataChannel 傳送 typing 事件（Prompt 7）。

#### P2-3：訊息時間戳格式不友善
- **影響頁面：** ChatPage
- **問題描述：** 時間戳直接顯示原始格式，未依「今天/昨天/更早」做智慧格式化。
- **建議修復：** 在 Prompt 7 中加入時間戳智慧格式化。

#### P2-4：聊天區域無「新訊息」提示
- **影響頁面：** ChatPage
- **問題描述：** 當使用者捲動到歷史訊息時，新訊息到達後無提示，使用者可能錯過。
- **建議修復：** 在 Prompt 7 中加入「↓ N 則新訊息」浮動按鈕。

#### P2-5：CSS 值全部硬編碼
- **影響頁面：** 全站
- **問題描述：** 所有 CSS 檔案使用硬編碼的顏色值（如 `#667eea`、`#333`、`#666`）、間距、圓角等。無 CSS custom properties，修改主題需逐檔更改。
- **建議修復：** 建立 variables.css 統一管理 design tokens（Prompt 8）。

#### P2-6：無 Dark Mode 支援
- **影響頁面：** 全站
- **問題描述：** 僅有淺色主題，深色環境下使用刺眼。
- **建議修復：** 在 Prompt 8 中利用 CSS variables 加入 dark mode。

#### P2-7：DashboardPage 的 onKeyPress 已過時
- **影響頁面：** DashboardPage
- **問題描述：** L236 使用 `onKeyPress`，此事件已被 Web 標準棄用，應改用 `onKeyDown`。
- **建議修復：** 替換為 `onKeyDown` 並確保行為一致。

---

### P3 — 美化級

#### P3-1：按鈕缺少明確 type 屬性
- **影響頁面：** 全站（DashboardPage、WaitingRoomPage、ChatPage）
- **問題描述：** 大量 `<button>` 未指定 `type="button"`，在 `<form>` 內時會預設為 submit，可能觸發意外的表單提交。
- **建議修復：** 在 Prompt 9 中統一加入 type 屬性。

#### P3-2：無 hover/focus 視覺一致性
- **影響頁面：** 全站
- **問題描述：** 各頁面的按鈕 hover/focus 效果不統一。部分按鈕有 translateY 動畫（WaitingRoomPage），部分僅改變背景色（DashboardPage）。focus 狀態幾乎未定義。
- **建議修復：** 在 Prompt 8 中統一互動狀態樣式。

#### P3-3：SVG 圖示無無障礙描述
- **影響頁面：** LoginPage
- **問題描述：** Google 登入按鈕的 SVG 圖示缺少 `aria-hidden="true"` 或 `<title>` 元素。
- **建議修復：** 在 Prompt 9 中修復。

#### P3-4：動畫效果不統一
- **影響頁面：** 全站
- **問題描述：** WaitingRoomPage 有 pulse 動畫和 hover lift，其他頁面風格較平。
- **建議修復：** 在 Prompt 8 的 design tokens 中統一動畫時長和曲線。

#### P3-5：空狀態設計過於簡陋
- **影響頁面：** DashboardPage
- **問題描述：** 房間列表為空時僅顯示 `.empty-state` 純文字，缺少插圖和引導性 CTA。
- **建議修復：** 加入空狀態插圖和「建立第一個房間」引導按鈕。

---

## 三、Mobile 適配詳細分析

| CSS 檔案 | 有 @media | 斷點 | 狀態 |
|-----------|-----------|------|------|
| LoginPage.css | ❌ | — | max-width: 400px 提供基本適配，但缺少小螢幕微調 |
| DashboardPage.css | ❌ | — | **嚴重缺失**：grid 佈局、flex 表單、header 均未適配 |
| WaitingRoomPage.css | ✅ | 600px | 基本適配：調整 padding、字體大小 |
| ChatPage.css | ❌ | — | **嚴重缺失**：全高佈局、輸入區域需要適配 |
| index.css | ❌ | — | 全域樣式，無需特別處理 |

**index.html viewport：** ✅ 已正確設定 `<meta name="viewport" content="width=device-width, initial-scale=1.0" />`

---

## 四、錯誤處理詳細分析

### alert() 呼叫清單（共 10 處）

| 檔案 | 行號 | 訊息 | 類型 | 替代方案 |
|------|------|------|------|----------|
| DashboardPage | 75 | 建立房間需要登入 | warning | Toast warning |
| DashboardPage | 113 | 建立房間失敗：{error} | error | Toast error |
| DashboardPage | 134 | 房間不存在 | error | Toast error |
| DashboardPage | 147 | 房間已關閉 | warning | Toast warning |
| DashboardPage | 158 | 房間不存在 | error | Toast error |
| DashboardPage | 181 | 房間已關閉 | warning | Toast warning |
| DashboardPage | 183 | 加入房間失敗 | error | Toast error |
| WaitingRoomPage | 144 | 連結已複製 | success | Toast success |
| WaitingRoomPage | 153 | 連結已複製 | success | Toast success |
| WaitingRoomPage | 240 | 啟動房間失敗 | error | Toast error |

### 靜默錯誤處理（.catch(() => {})）

| 檔案 | 行號 | 操作 | 風險 |
|------|------|------|------|
| RoomService.ts | 321 | leaveSession | 使用者不知離開失敗 |
| RoomService.ts | 340 | leaveSession | 使用者不知離開失敗 |
| RoomService.ts | 614 | updateDoc | peer 狀態未更新 |
| ChatPage.tsx | 66 | updateSessionHeartbeat | 連線監測中斷 |

### console.error 但無使用者通知（部分關鍵項）

| 檔案 | 行號 | 操作 | 建議 |
|------|------|------|------|
| ChatPage.tsx | 205 | P2P 初始化失敗 | 顯示 Toast error + 重連按鈕 |
| ChatPage.tsx | 269 | Chat 初始化失敗 | 顯示錯誤頁面 |
| ChatPage.tsx | 323 | 訊息傳送失敗 | 訊息氣泡顯示失敗狀態 |
| AuthContext.tsx | 49 | 匿名登入失敗 | 顯示 Toast error |

---

## 五、Loading 狀態詳細分析

| 元件 | 非同步操作 | 載入指示 | 品質 |
|------|-----------|----------|------|
| App.tsx Suspense | 程式碼分割載入 | `<p>載入中...</p>` | ❌ 純文字 |
| LoginPage | Email/Google 登入 | 按鈕文字「登入中...」+ disabled | ⚠️ 可接受但無動畫 |
| DashboardPage | 認證載入 | `<p>載入中...</p>` | ❌ 純文字 |
| DashboardPage | 房間列表訂閱 | 無（直接顯示空列表） | ❌ 無指示 |
| DashboardPage | 建立房間 | 按鈕 disabled（無文字變化） | ❌ 不明顯 |
| DashboardPage | 加入房間 | 無 | ❌ 完全缺失 |
| WaitingRoomPage | 房間資料載入 | `<div className="loading">載入中...</div>` | ❌ 純文字 |
| ChatPage | P2P 連線 | connection-status badge | ⚠️ 有但不醒目 |
| ChatPage | 歷史訊息載入 | 無 | ❌ 完全缺失 |

---

## 六、可及性 (a11y) 詳細分析

### ARIA 屬性

| 項目 | 狀態 |
|------|------|
| aria-label | ❌ 全站零使用 |
| aria-live | ❌ 聊天區域未設定（螢幕閱讀器無法播報新訊息） |
| aria-hidden | ❌ 裝飾性元素未隱藏 |
| role 屬性 | ⚠️ 僅 ChatPage connection-hint 有 `role="alert"` |

### 鍵盤導航

| 項目 | 狀態 |
|------|------|
| tabIndex 管理 | ❌ 全站零使用 |
| Skip-to-content | ❌ 不存在 |
| Focus 管理 | ❌ 無 focus trap 或 focus restoration |
| 鍵盤事件 | ⚠️ 僅 2 處：DashboardPage 建立房間 Enter、ChatPage 送訊息 Enter |

### 表單可及性

| 項目 | 狀態 |
|------|------|
| LoginPage labels | ✅ 正確使用 htmlFor + id 關聯 |
| DashboardPage checkbox | ⚠️ label 包裹 input 但無 htmlFor/id |
| DashboardPage 房間名稱 input | ❌ 無 label |
| ChatPage textarea | ❌ 無 label |

### 色彩對比度

| 組合 | 對比度 | WCAG AA |
|------|--------|---------|
| #333 on #fff | ~12.6:1 | ✅ 通過 |
| #666 on #fff | ~5.7:1 | ✅ 通過（勉強） |
| #999 on #f5f5f5 | ~2.8:1 | ❌ **不通過**（時間戳、已刪訊息） |
| #856404 on #fff3cd | ~4.6:1 | ✅ 通過 |
| white on #667eea | ~4.6:1 | ✅ 通過（勉強） |

---

## 七、建議執行順序

根據以上分析，建議依以下順序修復：

```
第一輪（P0 核心體驗）：
  Prompt 1：Toast 通知系統 → 解決 P0-1（10 處 alert）
  Prompt 4：Mobile Responsive → 解決 P0-2（3 個頁面無適配）
  Prompt 2：ConnectionBanner → 解決 P0-4（連線狀態無恢復機制）

第二輪（P1 體驗提升）：
  Prompt 5：Skeleton Loading → 解決 P1-1（純文字載入）
  Prompt 3：訊息傳送狀態 → 解決 P1-2（無送達回饋）
  Prompt 6：ShareModal → 解決 P1-4（分享體驗原始）

第三輪（P2 細節打磨）：
  Prompt 7：聊天細節 → 解決 P2-2~P2-4
  Prompt 8：Design Tokens → 解決 P2-5~P2-6

第四輪（P3 無障礙）：
  Prompt 9：Accessibility → 解決全站 a11y 問題
```

**預估影響最大的前三項：** Prompt 1（Toast）→ Prompt 4（Responsive）→ Prompt 2（ConnectionBanner）

---

## 八、技術備註

- **技術棧：** React 18 + TypeScript + Vite + Firebase + WebRTC
- **無外部 UI 庫：** 全部手寫 CSS，無 Tailwind/MUI/Ant Design
- **路由結構：** / → /login → /dashboard → /waiting/:roomId → /chat/:roomId
- **已有 viewport meta tag**，不需額外處理
- **已有 Enter/Shift+Enter 快捷鍵**，ChatPage handleKeyDown 實作正確
