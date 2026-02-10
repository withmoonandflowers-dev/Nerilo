# Nerilo - Firebase + WebRTC P2P 即時互動平台

## 專案簡介

Nerilo 是一個基於 Firebase + WebRTC 的 P2P 即時互動平台，提供文字聊天、音訊/視訊通話、檔案傳送等功能。所有使用者資料（聊天文字、檔案、影音）僅透過 P2P 傳輸，不儲存於伺服器端，確保資料隱私。

## 核心特性

- 🔒 **資料隱私**：聊天文字、檔案、影音僅透過 P2P 傳輸，不寫入 Firestore
- 🚀 **即時互動**：文字聊天、音訊/視訊通話、檔案傳送
- 🔄 **跨裝置同步**：同帳號兩台裝置同時在線可同步
- 📦 **模組化設計**：共用 P2P 通訊層，易於擴充新功能
- 🔐 **RBAC 權限控制**：基於 Firebase Auth Custom Claims
- 📝 **本機儲存**：使用 IndexedDB 儲存聊天紀錄（清除瀏覽器資料即永久遺失）

## 技術架構

### 前端
- React 18 + TypeScript
- Vite
- React Router
- Dexie (IndexedDB)

### 後端
- Firebase Authentication
- Cloud Firestore
- Cloud Functions
- Firebase Hosting

### P2P 通訊
- WebRTC (RTCPeerConnection, DataChannel, MediaStream)

## 快速開始

### 前置需求

- Node.js 18+
- npm 或 yarn
- Firebase 專案

### 安裝

```bash
# 安裝依賴
npm install

# 安裝 Functions 依賴
cd functions
npm install
cd ..
```

### 環境變數

建立 `.env.local`：

```env
VITE_FIREBASE_API_KEY=your-api-key
VITE_FIREBASE_AUTH_DOMAIN=your-project.firebaseapp.com
VITE_FIREBASE_PROJECT_ID=your-project-id
VITE_FIREBASE_STORAGE_BUCKET=your-project.appspot.com
VITE_FIREBASE_MESSAGING_SENDER_ID=123456789
VITE_FIREBASE_APP_ID=your-app-id
```

### 開發

```bash
# 啟動開發伺服器
npm run dev

# 啟動 Firebase Emulator（可選）
firebase emulators:start
```

### 建置

```bash
npm run build
```

### 部署

```bash
# 部署 Firestore Rules
firebase deploy --only firestore:rules

# 部署 Functions
firebase deploy --only functions

# 部署 Hosting
firebase deploy --only hosting
```

## 專案結構

```
nerilo/
├── src/
│   ├── core/
│   │   └── p2p/          # 共用 P2P 通訊層
│   ├── features/         # 功能模組
│   │   └── chat/        # 文字聊天
│   ├── services/         # 服務層
│   │   ├── IndexedDBService.ts
│   │   └── SyncService.ts
│   ├── contexts/        # React Context
│   ├── components/      # 共用元件
│   ├── pages/           # 頁面
│   └── types/           # TypeScript 類型定義
├── functions/           # Cloud Functions
├── docs/               # 文件
│   ├── 架構文件.md
│   ├── 協議文件.md
│   ├── 新功能接入SOP.md
│   ├── 部署手冊.md
│   └── *.puml         # PlantUML 架構圖
├── firestore.rules     # Firestore Security Rules
└── firebase.json       # Firebase 配置
```

## 核心元件

### 共用 P2P 通訊層

- **P2PConnectionManager**：管理 RTCPeerConnection 生命週期
- **P2PChannelBus**：管理 DataChannel，提供 send/subscribe API
- **P2PProtocolRegistry**：協議註冊與驗證
- **P2PFileTransferService**：檔案傳輸服務
- **P2PMediaService**：媒體服務

### 功能模組

- **ChatService**：文字聊天
- **SyncService**：跨裝置同步

## 文件

- [架構文件](docs/架構文件.md)
- [協議文件](docs/協議文件.md)
- [新功能接入 SOP](docs/新功能接入SOP.md)
- [部署手冊](docs/部署手冊.md)

## 協議設計

所有 P2P 訊息使用統一的 Envelope 格式：

```typescript
{
  v: 1,
  ns: "chat|file|media|sync|system|feature.xxx",
  type: "STRING",
  id: "UUID",
  ts: 1710000000000,
  from: "uid/deviceId",
  to?: "uid/deviceId",
  replyTo?: "UUID",
  payload: {},
  meta?: {}
}
```

詳細說明請參考 [協議文件](docs/協議文件.md)。

## 安全原則

### 硬性原則

- ❌ 聊天文字不得寫入 Firestore
- ❌ 檔案本體不得寫入 Firestore
- ❌ 影音內容不得寫入 Firestore
- ✅ Firestore 僅用於 signaling、功能註冊、使用者 profile

### 權限控制

- 基於 Firebase Auth Custom Claims
- Firestore Security Rules 作為最終裁決者
- P2P 功能僅 user/admin 可使用

## 瀏覽器支援

- 桌機：Chrome/Edge/Safari 最新兩版
- 行動裝置：iOS/Android 主流瀏覽器

## 授權

本專案為專案交付範例，請依實際需求調整。

## 聯絡

如有問題或建議，請參考文件或建立 Issue。


