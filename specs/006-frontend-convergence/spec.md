# Spec 006：前端收斂 — 畫面單純、聚焦

- 軌別：feature
- 狀態：done（2026-07-17，T1-T4 完成、V1-V4 驗收過）
- 建立：2026-07-16／最後更新：2026-07-17
- 關聯：ADR-0017（Vue/Nuxt 接班）、Spec 005（已完成——邀請連結會合＝主路徑的地基）

## 1. 要做什麼、為什麼（specify）

使用者操作前端時覺得「好亂」，要收斂功能、畫面單純。目前 Vue dashboard 塞了：主題循環鈕、
中繼狀態×點數卡、我的房間、P2P 公開房間目錄、好友、建/加房 sheet。本 spec 決定收斂後的
資訊架構：砍掉非主路徑的視覺元素，讓「聊天」與「遊戲」兩條路徑一眼可見。

**憲法檢核**：
- 目標函數加分項：可維運（少即是好維護）；補助競爭力（clean demo 比雜亂 demo 有說服力）。
- 四條不變量影響：四條皆〈無〉（純前端資訊架構，不動核心）。

## 2. 邊界

- 收斂在 **Vue/Nuxt 接班版**（`web-vue/`）上做；React 生產版凍結不動（ADR-0017）。
- 不動核心傳輸/加密；只動畫面與導覽。
- 不新增功能；本 spec 是「砍與合」——遊戲入口是**露出既有能力**（房內遊戲面板已存在），非新功能。
- **機制不隨 UI 陪葬**：節點 presence、盲信使、房間廣告廣播照跑（網路公民責任）；砍的只是首頁顯示。

## 3. 待釐清（clarify）——2026-07-17 使用者拍板

- [x] Q1+Q2 保留範圍：**聊天 + 遊戲雙入口**——首頁保留兩條路徑（聊天／遊戲），其餘全砍。
  「遊戲版本比較好」＝遊戲要有可見入口，非以遊戲為產品方向。
- [x] Q3+Q4 首頁收斂：**兩鍵制＝建房 + 我的房間**。砍：P2P 公開房間目錄、中繼點數卡、
  功能搜尋（Vue 版本無此項，僅 React 有——凍結不動）。主路徑＝建房→傳邀請連結
  （Spec 005 nrz1 會合連結即入口）。
- [x] Q5 主題：**單一乾淨主題＋深淺自動**。砍主題循環鈕；跟隨系統 prefers-color-scheme
  自動深淺。**取代 2026-07-05「預設 neo」定調**（今日拍板優先；neo tokens 檔案保留、
  design/neo.vue 展示頁不刪但無導覽入口）。

## 4. 技術計畫（plan）

### 4.1 主題（T1）

`useTheme` 改為深淺自動：`matchMedia('(prefers-color-scheme: dark)')` 決定 light/dark，
監聽系統切換即時跟隨；移除 cycle API 與 localStorage 持久化（單一主題無需記憶）。
dashboard 移除 ◐ 鈕。neo 作為 data-theme 覆蓋層的 tokens 保留在 main.css（不露出）。

### 4.2 Dashboard 砍與合（T2）

- 砍「中繼狀態×點數」卡（useCredits 於 dashboard 不再引用；點數機制照跑）。
- 砍「P2P 發現的公開房間」區塊與其 UI 訂閱（`roomDirectory.onChange`→`p2pRooms`）；
  **保留** `setRoomAdvertSource`（繼續替網路廣播我的公開房）與 courier/presence 啟動。
- 保留：標題、好友鈕+徽章、登出、＋、我的房間列表、空狀態、建/加房 sheet。
- **e2e 錨點遷移**：node-presence 與 room-directory 兩個 spec 原以 dashboard UI 為斷言錨
  （`online-node-count`、`p2p-room-directory`）。UI 砍除後改以 test hook 斷言機制
  （`__nerilo_test__` 曝露 presence peerCount 與 roomDirectory list，test mode only）——
  機制迴歸保護不降級，只換觀測點。

### 4.3 遊戲雙入口（T3）

建房 sheet 的建立表單改雙 CTA：「建立聊天室」／「建立遊戲室」。建遊戲室＝同一建房流程
＋sessionStorage 旗標（`nerilo:open-game:{roomId}`，同 introducerHint 模式）；chat 頁掛載
時讀旗標→gameBus 就緒後自動開遊戲面板（等同進房手按「開啟遊戲」，零新協議/資料模型）。
其他成員不受影響（照舊手動開）。

### 4.4 取捨

- 遊戲入口用 sessionStorage 旗標而非房間欄位（kind:'game'）：不動資料模型與 rules，
  「收斂」不夾帶功能；房型持久化留給未來真需求。
- 砍 UI 不砍機制：presence/courier/廣播照跑——這些是網路健康度，不是首頁資訊。

## 5. 任務分解（tasks）

- [x] T1 ⚠：主題深淺自動＋移除循環鈕。〔2026-07-17：useTheme 改 matchMedia 監聽即時跟隨；
  dashboard/chat 頁 ◐ 鈕移除；design/neo 展示頁改自帶 previewCycle；game-theme e2e 主題段
  改寫為 emulateMedia 深淺斷言＋「無切換鈕殘留」收斂斷言。〕
- [x] T2 ⚠：dashboard 砍卡與目錄。〔2026-07-17：砍中繼點數卡＋P2P 公開房間目錄（含死 CSS）；
  機制照跑（presence/courier/廣播）；test hook 曝露 `__nerilo_test__.presence/.roomdir`；
  node-presence／room-directory e2e 改 hook 斷言（機制迴歸不降級）。dashboard 862→794 行。〕
- [x] T3：建房 sheet 雙 CTA。〔2026-07-17：「建立聊天室／🎮 建立遊戲室」；lib/gameRoomFlag
  （sessionStorage 一次性旗標）＋chat 頁 gameBus 就緒自動開面板；4 unit tests（一次性/跨房
  隔離/隱私模式降級）。chat 頁 1172→1167 行（棘輪反向調低）。〕
- [x] T4：驗收。〔2026-07-17：nuxt typecheck✓、unit 1477 綠、lint 0 err、Vue e2e 7/7 綠
  （golden-path/friends/gomoku/game-seats 迴歸＋game-theme/node-presence/room-directory 改寫版）。〕

## 6. 驗收（黃金判準）

- [x] V1：首頁區塊數下降（砍 2 區塊 1 鈕，dashboard -68 行）；主路徑「建房→傳連結」兩步可達。
- [x] V2：遊戲入口一眼可見（建立表單雙 CTA）；自動開面板由 gameRoomFlag unit＋既有遊戲
  e2e（手動開路徑）覆蓋——旗標→面板的 watchEffect 膠水極薄，額外三瀏覽器 e2e 不成比例。
- [x] V3：主題跟隨系統深淺（e2e emulateMedia 斷言）＋「無切換鈕殘留」e2e 斷言。
- [x] V4（迴歸）：核心 e2e 7/7 綠；presence/roomdir hook 斷言仍綠——砍的是 UI 不是能力。

## 7. 一致性自查（analyze）

- [x] 方案覆蓋需求、無多做（遊戲入口=露出既有能力；唯一新增是 sessionStorage 旗標）
- [x] 任務完整實現方案
- [x] 驗收能證明需求（V4 專門防「砍 UI 誤砍機制」）
- [x] 未違反憲法任何一條
