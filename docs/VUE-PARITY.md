# Vue 接班 parity matrix

> 2026-07-16 本機 emulator 基線。這是可執行覆蓋清單，不取代 ADR-0017 的兩週觀察期、正式環境 smoke 或產品負責人視覺驗收。

## `@vue-stable` 九條旅程

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

`parity.spec.ts` 暴露出控制面 `keyx/read` 與聊天共用 10 msg/s bucket 的 P1 問題；核心現已按 channel 分桶，控制訊息不再消耗合法聊天 burst 額度，並有單元測試鎖定。

## 尚未取得的切換證據

- `@vue-stable` 必須從 2026-07-16 連續觀察到 2026-07-30，之後才能移除 soft gate。
- Vue build 的 production smoke 尚需直連、強制 TURN、誠實 fallback 三路全綠。
- 產品負責人尚未完成視覺驗收；hosting 仍應保留 React artifact 與一鍵回退。
- 正式環境身份、網路與 Firebase 配額行為不能由 emulator 結果代替。
