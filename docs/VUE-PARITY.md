# Vue 接班 parity matrix

> 2026-09-03 本機 emulator 基線。這是可執行覆蓋清單，不取代 ADR-0017 的正式環境 smoke 或產品負責人視覺驗收。

## `@vue-stable` 十二條旅程

| 旅程 | Spec | 覆蓋 |
|---|---|---|
| 黃金聊天路徑 | `golden-path.spec.ts` | 註冊、建房、加入、雙向訊息 |
| E2EE 指示 | `e2ee-indicator.spec.ts` | 金鑰狀態與加密 UI |
| 好友 | `friends.spec.ts` | 搜尋、邀請、接受 |
| 遊戲主題 | `game-theme.spec.ts` | 第二應用／主題入口 |
| mesh 診斷 | `mesh-diagnostic.spec.ts` | 真 WebRTC mesh 狀態 |
| 訊息 parity | `parity.spec.ts` | Unicode、5KB、10 則 burst、整頁重載去重與順序 |
| persistent rooms | `persistent-rooms.spec.ts` | 房間跨重載保留 |
| rejoin | `rejoin.spec.ts` | 離房再進與歷史補齊 |
| 信使欠條 | `relay-connect.spec.ts` | 報價／欠條計量與本人結清 |
| 雙房獨立性 | `independent-meshes-bootstrap-independence.spec.ts` | 各房獨立 bootstrap、斷 signaling 後續傳、跨房隔離 |
| migration window | `migration-window.spec.ts` | 第三人加入並行送訊息，既有成員與加入後訊息不重不漏 |
| p2p2p introduction | `p2p2p-introduction.spec.ts` | 第三人經加密介紹加入，被介紹 pair 不走 Firestore signaling |

CI 另把 `_warmup.spec.ts` 放進同一個 Playwright process，避免 Nuxt 首次路由編譯時間污染產品
斷言；因此完整 stable gate 為 13 項。2026-09-03 本機 13/13，全套另對 migration 重跑 5 輪、
p2p2p introduction 重跑 3 輪，皆全綠。

`parity.spec.ts` 暴露出控制面 `keyx/read` 與聊天共用 10 msg/s bucket 的 P1 問題；核心現已按 channel 分桶，控制訊息不再消耗合法聊天 burst 額度，並有單元測試鎖定。

## 尚未取得的切換證據

- 兩週觀察已達標：GitHub Actions API 查核 2026-08-18 至 09-02 共 16 次排程，Vue E2E job
  與實際測試 step 全為 success；2026-09-03 工作樹已移除 soft gate，待提交後由 CI 驗證生效。
- Vue build 的 production smoke 尚需直連、強制 TURN、誠實 fallback 三路全綠。
- 產品負責人尚未完成視覺驗收；hosting 仍應保留 React artifact 與一鍵回退。
- 正式環境身份、網路與 Firebase 配額行為不能由 emulator 結果代替。

另有獨立的 Spec 027 本機會合點瀏覽器驗收，不混入 Vue 接班 gate：
`npm run test:e2e:rendezvous` 以兩個隔離 Chromium 驗證單人等待提示、兩人 P2P/E2EE 就緒與訊息互通。
