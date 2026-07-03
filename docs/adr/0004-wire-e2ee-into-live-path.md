# ADR-0004：將 E2EE 接入即時訊息路徑

- 狀態：Proposed
- 日期：2026-07-03

## Context

README 與威脅模型以 E2EE 為核心賣點，但實際上加密從未生效：

- SenderKeyManager（AES-256-GCM 加 ECDH P-256，含自動輪替）實作完整且有測試，
  但 useStarTopology.ts:136-142 建立 ChatService 時沒有注入，
  ChatService.ts:141 的加密條件永遠為 false，isE2EEEnabled 恆為 false。
- P2P 失敗時的 Firestore fallback（ChatPage.tsx:437-439）直接寫明文，
  而弱網路使用者恰恰是最依賴 fallback 的族群。

在此狀態下對外宣稱 E2EE 構成不實宣稱，是商業化的法律與信任風險，
也是整個價值主張的地基。

## Decision

1. 在星型拓撲的房間初始化流程建立 SenderKeyManager 並注入 ChatService，
   金鑰交換走既有的 P2PChannelBus 廣播。
2. Firestore fallback 改為「先加密再寫入」：fallback 訊息 payload 一律是
   SenderKeyManager 加密後的密文，Firestore 只見密文與路由 metadata。
   金鑰交換若尚未完成則 fallback 暫存並顯示等待狀態，不得默默降級為明文。
3. mesh 拓撲（3 人以上）的群組金鑰分發列為第二階段；完成前，UI 明確標示
   該房間「傳輸加密（DTLS），非端對端加密」，不得籠統標示 E2EE。
4. UI 增加每房間的加密狀態指示，狀態來源是 ChatService.isE2EEEnabled 的真值，
   不是寫死的圖示。

## Consequences

- 產品宣稱與行為一致，威脅模型文件恢復有效性。
- 每則訊息多一次 SubtleCrypto 加解密，對聊天流量而言可忽略。
- fallback 加密後，訊息在 Firestore 中不可被伺服器端搜尋或審查。這是刻意取捨，與隱私定位一致；若 ADR-0009 選擇需要伺服器端內容審查的市場，本項需重新評估。
- 金鑰交換未完成前訊息會延遲送出，需要 UX 配合（等待狀態），是體驗成本。
- 既有明文歷史訊息不回溯加密，僅適用於新訊息。
