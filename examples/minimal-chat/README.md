# minimal-chat — Nerilo reference 整合

一個第三方消費者要嵌入 Nerilo 的最小可跑範例：`import { createChatClient } from 'nerilo'`，四道注入縫全走記憶體 adapter，零 Firebase，同頁兩個 client 經 WebRTC 直連並端到端加密互傳。

證明三件事：

1. **可消費**：`nerilo` 這個套件（此範例把它指到 build 出來的 `dist`，等同 npm 拿到的東西）import 得進來、型別正確、bundle 得起來。
2. **注入縫是真的**：signaling / directory / storage 全部換成 `InMemory*` 參考實作，核心照跑，不需要任何後端帳號。
3. **端到端會動**：alice 送的訊息，bob 從加密 DataChannel 收到（見 `src/main.ts`，只用 `NeriloClient` 公開門面）。

## 跑起來

在 repo 根目錄：

```bash
npm run example:minimal        # 先 build:sdk，再開 dev server（http://localhost:5180）
```

打開後兩欄 alice / bob 都會顯示「已連線」，在任一側輸入送出，另一側即時收到。

production build（驗證消費者能打包）：

```bash
npm run example:minimal:build
```

## 檔案

- `src/main.ts` — 整段整合邏輯。建 client、注入後端、connect、onMessage、sendMessage。
- `vite.config.ts` — 把套件名 `nerilo` alias 到 `../../dist/index.js`。
- `index.html` — 無框架的最小 UI。

## 邊界

記憶體 adapter 只在同一個 JS context 內互通（適合此範例、整合測試、同頁展示）。要跨裝置、跨分頁，把 signaling 換成 Firestore 預設或你自架的後端，見 [../../docs/SDK-QUICKSTART.md](../../docs/SDK-QUICKSTART.md)。`connect()` 需要瀏覽器的 WebRTC 與 SubtleCrypto。
