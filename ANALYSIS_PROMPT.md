# Nerilo 專案分析與修復 Prompt

> 複製以下內容，貼到你的 AI 助手（Claude / Cursor / ChatGPT 等）中使用。

---

## Prompt 開始

```
你是一位資深的 Full-Stack 工程師，專精 React + TypeScript + Firebase + WebRTC。
請幫我全面分析並修復 Nerilo 這個專案，目標是讓它可以成功在本地開發環境運行，並最終部署到 Firebase。

## 專案概述

Nerilo 是一個基於 Firebase + WebRTC 的 P2P 即時互動平台，功能包含：
- 文字聊天（Star / Mesh 拓撲）
- 音訊/視訊通話
- 檔案傳送
- 所有使用者資料僅透過 P2P 傳輸，不儲存於伺服器端

技術棧：
- 前端：React 18 + TypeScript + Vite
- 後端：Firebase Auth + Cloud Firestore + Cloud Functions
- P2P：WebRTC (RTCPeerConnection, DataChannel, MediaStream)
- 本機儲存：Dexie (IndexedDB)
- 測試：Vitest (Unit) + Playwright (E2E) + Firebase Emulator (Integration)

## 請依序執行以下分析步驟

### 第一階段：環境與建置檢查

1. **檢查 Node.js 版本**是否 >= 18
2. **執行 `npm install`** 並記錄所有 warning / error
3. **執行 `cd functions && npm install`** 檢查 Cloud Functions 的依賴
4. **檢查 `.env.local`** 是否存在且包含所有必要的 Firebase 環境變數：
   - VITE_FIREBASE_API_KEY
   - VITE_FIREBASE_AUTH_DOMAIN
   - VITE_FIREBASE_PROJECT_ID
   - VITE_FIREBASE_STORAGE_BUCKET
   - VITE_FIREBASE_MESSAGING_SENDER_ID
   - VITE_FIREBASE_APP_ID
5. **執行 `npm run type-check`**（即 `tsc --noEmit`），列出所有 TypeScript 錯誤
6. **執行 `npm run lint`**，列出所有 ESLint 錯誤
7. **執行 `npm run build`**（即 `tsc && vite build`），確認是否能成功打包

### 第二階段：核心架構分析

請逐一分析以下核心模組，找出潛在問題：

#### P2P 通訊層 (`src/core/p2p/`)
- `P2PConnectionManager.ts` — RTCPeerConnection 生命週期管理
- `P2PManager.ts` — P2P 編排、DataChannel 建立、能力協商
- `P2PChannelBus.ts` — DataChannel 抽象層
- `HelloNegotiator.ts` — HELLO/HELLO_ACK 能力協商協議
- `P2PFileTransferService.ts` — 檔案傳輸
- `P2PMediaService.ts` — 音視訊串流
- `P2PProtocolRegistry.ts` — 協議註冊與驗證

重點檢查：
- ICE candidate 是否有正確的 buffering 和排序
- Signaling (Firestore) 的 offer/answer 流程是否完整
- DataChannel 的 open/close/error 事件處理
- 連線斷開後的重連機制

#### Mesh 網路層 (`src/core/mesh/`)
- `MeshTopologyManager.ts` — k=6 鄰居拓撲管理
- `MeshGossipManager.ts` — Gossip 訊息傳播
- `GossipMessageHandler.ts` — Gossip 訊息處理
- `SecurityManager.ts` — ECDSA P-256 訊息簽名/驗證
- `IdentityManager.ts` — 使用者身分驗證
- `SharedDataStream.ts` — 區塊鏈式共享資料結構

重點檢查：
- Mesh 初始化的 30 秒超時是否足夠
- 鄰居輪替（每 2 分鐘）邏輯是否正確
- Gossip 訊息的去重和已讀管理
- 斷線重連的指數退避（1s → 30s）

#### 帳本與鏈 (`src/core/ledger/`, `src/core/chain/`)
- `SharedLedgerEngine.ts` — 共享帳本引擎
- `ForkResolver.ts` — 分叉解決
- `ChainMergeService.ts` — 鏈合併
- `ChainSyncService.ts` — 鏈同步

#### 服務層 (`src/services/`)
- `RoomService.ts`（799 行）— 房間生命週期管理（建立、加入、離開、關閉、主機遷移）
- `IndexedDBService.ts` — IndexedDB 本機儲存
- `FirestoreChatFallback.ts` — P2P 不可用時的 Firestore 備援

重點檢查：
- RoomService 的 Firestore Transaction 是否正確處理並發
- 主機遷移（host migration）流程的完整性
- 房間狀態機：waiting → open → migrating → closed

#### React Context (`src/contexts/`)
- `AuthContext.tsx` — Firebase Auth、角色分配、匿名登入
- `FeatureContext.tsx` — 功能註冊表
- `ServicesContext.tsx` — P2P Manager、RoomService 的依賴注入

重點檢查：
- AuthContext 中的匿名登入邏輯
- Context 之間的依賴順序
- useEffect 清理函數是否正確

### 第三階段：已知問題清單

以下是我已識別的問題，請確認並提供修復方案：

#### 🔴 嚴重（Critical）
1. **Firebase API Key 寫死在原始碼中**
   - `src/config/firebase.ts` 中有硬編碼的 API Key
   - `env.local` 已被加入 git（應在 .gitignore 中）
   - 需要：改用環境變數 + 從 git 歷史移除

2. **大量 console.log 暴露敏感資訊**
   - 約 280+ 個 console.log 散佈在整個程式碼庫
   - AuthContext 輸出 customClaims（角色、權限）
   - RoomService 輸出參與者列表和房間 ID
   - 需要：建立環境感知的 logger 工具

3. **缺少關鍵安全標頭**
   - firebase.json 缺少：HSTS、Content-Security-Policy、X-XSS-Protection
   - 需要：在 firebase.json hosting config 中補上

#### 🟡 高優先（High）
4. **匿名登入預設啟用** — AuthContext 在沒有認證使用者時自動觸發 signInAnonymously
5. **WebRTC SDP 未簽名** — offer/answer 以明文透過 Firestore 傳輸
6. **無 Session Timeout** — 使用者永久保持認證狀態
7. **無速率限制** — Firestore signals 子集合可被無限寫入
8. **DEBUG_AUTH = true 寫死** — AuthContext.tsx 中的除錯模式

#### 🟠 中優先（Medium）
9. **Mesh 初始化超時可能不足** — 大型房間 30 秒可能不夠
10. **ICE candidate 排序問題** — Firestore 降序可能導致 candidate 在 offer/answer 之前到達
11. **空 Firestore 文件可能造成競態條件** — 已有 4 次重試機制緩解

### 第四階段：測試驗證

1. **執行單元測試**：
   ```bash
   npm run test:run
   ```
   列出所有失敗的測試案例並分析原因。

2. **啟動 Firebase Emulator 並執行整合測試**：
   ```bash
   npm run test:emulator
   ```
   檢查 Firestore Security Rules 是否正確。

3. **執行 E2E 測試**（需先啟動 dev server）：
   ```bash
   npm run test:e2e
   ```

4. **對每個失敗的測試，提供：**
   - 失敗原因分析
   - 具體修復程式碼
   - 修復後的驗證方法

### 第五階段：讓專案成功運行

請提供從零到成功運行的完整步驟：

1. **本地開發環境啟動**：
   ```bash
   npm install
   cd functions && npm install && cd ..
   # 設定環境變數
   firebase emulators:start --only auth,firestore
   npm run dev
   ```

2. **確認以下功能正常運作**：
   - [ ] 登入頁面正常顯示
   - [ ] Firebase Auth 認證成功（Email 或匿名）
   - [ ] Dashboard 頁面載入
   - [ ] 可以建立房間
   - [ ] 其他使用者可以加入房間
   - [ ] Waiting Room → 房間啟動
   - [ ] P2P 連線建立（WebRTC signaling 完成）
   - [ ] DataChannel 開啟，文字聊天正常
   - [ ] 離開房間後正確清理

3. **如果有任何步驟失敗**，請：
   - 詳細描述錯誤訊息
   - 找出根本原因
   - 提供具體修復
   - 驗證修復有效

### 第六階段：部署前檢查

1. **安全性**：
   - 確認 .env.local 在 .gitignore 中
   - 確認 firebase.json 有正確的安全標頭
   - 確認 firestore.rules 覆蓋所有集合
   - 確認 Cloud Functions 有權限檢查

2. **效能**：
   - Vite build 的 bundle size
   - 是否有 code splitting
   - 是否有不必要的大型依賴

3. **部署**：
   ```bash
   npm run deploy:safe  # type-check + lint + test + deploy
   ```

## 輸出格式

請用以下格式回覆：

### 📋 分析總結
- 環境狀態：✅ / ❌
- 建置狀態：✅ / ❌
- TypeScript 錯誤數：N 個
- ESLint 錯誤數：N 個
- 單元測試：N/N 通過
- 整合測試：N/N 通過
- E2E 測試：N/N 通過

### 🔧 需要修復的問題（按優先級排序）
1. [嚴重] 問題描述 → 修復方案
2. [高] 問題描述 → 修復方案
...

### 📝 修復步驟（可直接執行的指令和程式碼）
（逐步提供可複製貼上的修復程式碼）

### ✅ 驗證清單
（修復後的驗證步驟）
```

---

## 使用建議

1. **分段使用**：如果 AI 無法一次處理完，可以將 Prompt 拆成六個階段分別執行
2. **提供完整上下文**：將整個專案資料夾提供給 AI（如用 Cursor 或 Claude Code 直接開啟專案）
3. **迭代修復**：每修復一個問題後，重新跑一次 `npm run ci`（type-check + lint + test）確認沒有引入新問題
4. **優先處理建置錯誤**：先讓 `npm run build` 通過，再處理運行時問題
