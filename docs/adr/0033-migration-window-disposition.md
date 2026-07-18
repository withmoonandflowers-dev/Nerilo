# ADR-0033：React 遷移窗掉信不修，靠 Vue 切換退役星型棧收斂

- 狀態：Accepted（2026-07-18 使用者拍板，Spec 010 Q1-Q5）
- 日期：2026-07-18
- 關聯：Spec 010、ADR-0023（修訂五 P2-③ star 退役）、ADR-0017（切換門檻第 6 點）、docs/QA-REPORT-chat.md 已知限制

## Context

React 產線 2 人房走星型棧、第 3 人加入切 mesh。切換是拆棧重建：星型時代與
切換窗內送出的訊息不在 gossip store，mesh anti-entropy 管不到——非對稱切換
時（兩端切換時點不同步）會無聲掉信，遲到者永遠補不到星型時代歷史，且 UI
的「已送達」是 1.5 秒模擬回執，掉信對寄件者不可見。這是 QA 第三輪已知限制、
mesh 正確性殘留清單第 2 項。窗的完整盤點（W1-W5）與逐檔錨點見 Spec 010 第 1 節。

Vue 接班線已於 2026-07-07（ADR-0023 P2-③）把 star 整個退役：2 人房從第一則
訊息起走 gossip 複寫日誌，store-first + anti-entropy 補送，設計上不存在
「兩個棧」，問題類同構消滅。

## Decision

**不修 React 產線，記為誠實邊界，由 Vue 切 production 退役星型棧收斂。**

為什麼不選其他路：

- 把 star 退役移植回 React：施工圖現成（Vue 三階段），但違反 React 凍結
  決策，且是對唯一 production 線的大改，最早兩週後（2026-07-30 觀察期滿）
  就退役——高風險低殘值。
- React 窗內最小緩解（切換期雙寫備援）：只解一部分窗，遲到者歷史無解，
  等於在將死的程式碼上蓋新可靠性機制，回歸成本照付。
- 星史注入 mesh store：撞身分域對映（firebase uid vs mesh userId）、簽章
  歸屬（星型訊息無 gossip 簽章，代簽等於偽造他人紀錄）、加密域轉換三座
  硬牆，否決。

「不修」不能只是口頭承諾，配套兩件事把收斂閉環：

1. **回歸鎖**：`tests/e2e-vue/migration-window.spec.ts`（`@vue-stable`）——
   三人房「第三人加入的同時」三方連發、不等任何 mesh 就緒訊號、矩陣全 =1，
   把 React 診斷測試（`tests/e2e/mesh-diagnostic.spec.ts`）刻意繞開的時窗
   直接納入斷言，證明接班線確實沒有這個窗。
2. **掛切換門檻**：上述回歸鎖列為 ADR-0017 切換門檻第 6 點（使用者同意
   動門檻）。切換完成＝星型棧退役＝本已知限制自然關閉。

## Consequences

- 切換完成前，React production 使用者持續暴露在遷移窗掉信與遲到者歷史缺失；
  切換若延期，暴露期跟著延長。此為本決策的已知代價，記於 QA-REPORT 與
  CURRENT-STATUS，不藏。
- 「已送達」模擬回執（React/Vue 皆有）讓掉信不可見，屬獨立工作項另行處理，
  不在本決策範圍。
- mesh 正確性殘留清單第 2 項狀態改為「已定案處置（disposition），隨切換
  關閉」，後續進場者不必重新考古。
