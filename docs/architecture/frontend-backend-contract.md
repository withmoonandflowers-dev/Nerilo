# 前後端合約（分離邊界）

> 目的：讓 UI 可獨立換皮/重寫（React→Vue、改風格）而**不觸碰、不需理解後端**。
> 這份定義兩者的邊界與 UI 可用的後端表面。改前端風格時，只讀這份就夠。

## 鐵律：依賴方向單向（機器強制）

```
前端（UI）  ──依賴──▶  後端（core / services / ports / types / utils）
後端  ──✗ 永不依賴──  前端
```

- **後端**（`src/core/**`、`src/services/**`）：純 TypeScript，**零框架依賴**（無 React、
  無 Vue）。這是 Vue 重寫能複用同一後端的原因。
- **前端**（`src/features`、`pages`、`components`、`hooks`、`contexts` / 或 `web-vue/`）：
  只做 UI，透過下方表面呼叫後端。

**強制方式**：ESLint 規則（`.eslintrc.cjs` 合約邊界 override）——後端一旦 import
`react`/`vue` 或任何前端目錄，`npm run lint` 立即報錯。已驗證會擋。**不靠人自律。**

## UI 可用的後端表面（換皮就照這張表）

改前端只需要知道這些入口，其餘 core 內部一律不用碰：

| 能力 | 後端入口 | UI 怎麼用 |
|---|---|---|
| 連線/傳輸 | `core/p2p/P2PManager`（`getChannelBus()` / `getStateChannel()`） | 取 bus/通道 |
| 收送訊息 | `core/p2p/P2PChannelBus`（`subscribe(ns,fn)` / `send(env)`） | 訂閱/發送 |
| 房間 | `services/RoomService` + `ports/IRoomService` | 建/加入/離開/訂閱房間 |
| 房間活性 | `services/RoomHeartbeat`（`startRoomHeartbeat`） | 房主心跳 |
| 聊天 | `features/chat` 的 topology hooks（內部包 ChatService） | 送收聊天訊息 |
| 加密狀態 | `core/crypto/SenderKeyManager` | 顯示 E2EE 就緒/交換中 |
| 點數 | `core/incentive/CreditEconomy`（`getBalance`/`trySpend`/`subscribe`） | 顯示/花點數 |
| 本機儲存 | `services/IndexedDBService` + `ports/IChatStorage` | 歷史/檔案 |
| 座標/地球 | `utils/geo` + presence（`hooks/usePeerGlobe`） | 連線視覺 |
| 型別合約 | `src/types`（`P2PEnvelope` 等）、`ports/*` | 共用型別 |

> 遊戲的完整後端合約另見 [docs/game/GAME-SDK-SPEC.md](../game/GAME-SDK-SPEC.md)。

## 換前端風格 / 重寫的準則

1. **只動 UI 層**：樣式、版面、元件、互動。後端一行都不用改。
2. **不要在 UI 放商業邏輯**：加密、房間規則、點數計算屬後端；UI 只呈現與呼叫。
3. **透過上表入口取資料**：不要繞進 core 內部類別的私有細節。
4. **型別從 `src/types` / `ports` 拿**：前後端共用同一份型別合約。
5. **後端不會反過來叫你**：後端不知道 UI 存在（單向），所以你換框架它不會壞。

## 現況與理想（誠實）

- ✅ **已達成**：後端對前端零依賴（稽核 + lint 雙重確認）。這是分離最關鍵的一半，
  也是 Vue 重寫可行的基礎。
- 🟡 **可再收斂**：現行 React UI 直接 import 多個具體 core 類別（P2PChannelBus、
  MeshGossipManager、SenderKeyManager…），非全部經 `ports/` 介面。理想是 UI 只依賴
  `ports/` 抽象。但既有 React 正被 Vue 取代，不值得重構將棄用的碼；**新前端（Vue）
  請優先依賴上表入口與 `ports/`**，把表面收斂在此。

## 一句話

> 後端是框架無關的純邏輯，且被 lint 釘死「永不依賴前端」。改 UI 風格 = 只動前端、
> 照上表呼叫後端、後端不會壞。這就是「換皮更專注」的保證。
