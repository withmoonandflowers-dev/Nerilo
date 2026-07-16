# Nerilo 現況（單一事實來源）

> 最後更新：2026-07-16。README、CLAUDE、跨機器 handoff 與 roadmap 若涉及「現在做到哪」或測試數字，以本檔為準；ADR 與 spec 仍是設計決策與功能驗收的權威來源。

## 定位與交付面

- Nerilo 是可嵌入的 P2P 韌性資料傳遞層；聊天是參考應用，不是最終產品邊界。
- SDK 版本 `0.9.0`，可零 Firebase 嵌入；API 在 0.x 階段尚未鎖定。
- React 版仍是 Firebase Hosting production；Nuxt/Vue 接班版可 type-check、static generate，尚未取得切 production 資格。
- Firebase Functions 未部署。Hosting 與 Firestore rules/indexes 由 master push workflow 部署；需 Blaze／Cloud Build 的 Functions 能力仍刻意排除。
- Lemon Squeezy／Netlify webhook 付款鏈已驗證，但 store 仍在 test mode，且 Pro 目前主要是身分標記，尚無完整伺服器端配額權益。

## 已驗證基線

| 層級 | 2026-07-16 基線 |
|---|---|
| Core quality | TypeScript、ESLint gate 通過；124 test files／1412 tests 全綠（既有 7 warnings） |
| SDK | build 通過；入口 Firebase isolation 硬閘通過 |
| React stable E2E | 2026-07-15 emulator-backed 11/11 |
| Nuxt quality | `nuxt typecheck`、`nuxt generate` 通過 |
| Nuxt stable E2E | `@vue-stable` 2/2（黃金訊息路徑＋信使欠條），固定 1 worker 隔離 spec |
| Spec 001 affected E2E | 真 WebRTC＋Firebase emulator 欠條計量 1/1 |

## 目前完成度

### 核心傳輸

- 2 人與 mesh 聊天、E2EE、fallback 密文、因果順序、去重與 TURN production smoke 已有可執行證據。
- SDK 已抽出公開入口、quickstart 與 minimal example，且不會從 eager import 偷帶 Firebase。
- `game/`、`community/` 與部分 relay/transport 能力仍有「已測但未完整接入產品流」的模組；不可把單元測試等同 production 接線。

### 信使寄存經濟（Spec 001）

- T1：寄存不刷新 LRU；per-簽章身分占用統計。
- T2：分散式擁擠定價、byte-day 計價、一價收斂測試；QUOTE 請求頻率不能操縱調價。
- T3：QUOTE、本人簽發寄存欠條、per-發票人未結上限與拒收。
- T4：有明確對象的服務欠條可在原發票人、目前持有人、新持有人三方同意後交換；自己的欠條只有本人簽署才結清。
- T5：單一垃圾身分耗盡授信後連續 19 筆拒收，誠實房未被擠出。
- 尚餘 T6：回填正式 ADR 與 protocol 軌格式；V4「信使全拒仍走成員互補」需獨立可執行驗收。

這套經濟不是 coin 或全網餘額。每個信使只對自己持有的債權作權威判斷，不同發票人的欠條只有在使用者同意的交換中才具可比價格。

### Nuxt 接班

- CI `vue-quality` 已是硬閘：`nuxt typecheck`＋`nuxt generate`。
- CI `vue-e2e` 自 2026-07-16 起觀察，最早 2026-07-30 才可移除 `continue-on-error`。
- Production 切換完整門檻見 ADR-0017：Vue E2E 硬閘、P0/P1 清零、Vue production smoke 三路全綠、視覺驗收與可回退 artifact，缺一不可。

## 目前優先序

1. 完成 Spec 001 T6 與 V4，收口欠條協議及免費底線服務證據。
2. 觀察 Vue stable CI 到 2026-07-30；期間補齊 P0/P1 parity，不提前切 production。
3. 把成本儀表板、總量配額與 cleanup Functions 的 Blaze 決策獨立處理；Functions 未部署前，不宣稱伺服器端成本上限已完整成立。
4. 取得真實使用資料後再擴功能；避免 React、Vue、SDK 三面同時發散。

## 已知風險與誠實邊界

- CI 中 React stable E2E 與 Vue stable E2E 目前仍是 soft gate；Vue 觀察截止日為 2026-07-30，React 既定檢查日為 2026-07-27。
- Nuxt 最大 bundle chunk 約 568 kB；不擋 correctness，但切 production 前應評估載入成本。
- SDP offer/answer 尚未升級為平台級簽章身分；Firebase auth/rules 是現階段信令完整性邊界。
- 信使欠條目前是每信使本地債權簿；跨節點長期持久化、遺失復原與 protocol 相容格式屬 Spec 001 T6。
- README 的安全摘要不能取代 `docs/THREAT_MODEL.md`；Nerilo 未經第三方安全認證，不適用高風險匿名通訊。
