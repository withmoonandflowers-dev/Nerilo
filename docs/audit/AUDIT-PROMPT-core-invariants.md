# Nerilo 核心不變量稽核 Prompt（可重複使用）

> 用法：把本文件整份餵給稽核者（人或 AI），搭配 repo 讀取權限。每次大版本、
> 或動到 core/mesh、core/crypto、core/incentive、firestore.rules 前後各跑一次。
> 產出可交外部顧問（補助案技術查核、資安顧問）閱讀的脫敏報告。

---

你是一名資深分散式系統架構師與安全審計顧問，專精「P2P 端到端加密通訊與去中心化激勵帳本」。
請完整掃描 Nerilo 專案中與「核心不變量」相關的所有功能與程式碼，產出一份「可提供給外部顧問閱讀的脫敏技術評估報告」。

請把以下四項視為「錯了等於真實損失」的資產來評估，每一項都對應產品的存亡承諾：

1. **訊息恰好一次**：每則訊息在寄收兩端各出現恰好一次。掉訊或重複等於核心承諾破產。
2. **E2EE 機密性**：伺服器（Firestore）與盲信使只能看到密文。明文外洩等於隱私定位破產。
3. **點數帳本正當性**：點數只能由可驗證的共簽收據產生，帳鏈不可篡改。可偽造等於激勵經濟破產。
4. **身分與授權**：訊息不可冒名（ECDSA 簽章），資料不可越權寫（firestore.rules）。

## 評估範圍（先界定，不得超出實際程式碼）

只評估與核心不變量相關的路徑，包含但不限於：

- 訊息收發：gossip 廣播、seq 保留（reserve-then-send）、(senderId, seq) 去重、anti-entropy 對帳、因果排序（HLC/deps）
- 加密：身分金鑰（ECDSA P-256）、ECDH 金鑰交換（keyx 通道）、房間內容金鑰（sender key/epoch）、輪替與前向保密
- 備援路徑：Firestore fallback（必須密文）、盲信使寄存（deposit/pull/tombstone）
- 應用通道：chat / game / keyx / reaction / read 的分流與各自語義（可靠 vs lossy）
- 點數：中繼收據（共簽）、CreditLedger 雜湊鏈、verify、發點與扣點路徑
- 身分與規則：meshIdentities 註冊、firestore.rules 的授權模型、memberStates 自寫限制
- 離開再進（rejoin）、重載、多裝置、跨會話等邊界情境
- SDK 注入面：signaling / directory / storage 注入縫是否破壞上述不變量

## 評估重點

- 系統技術棧與整體架構、模組依賴關係
- 訊息生命週期完整流程：送出、簽章、加密、gossip、去重、對帳、落庫、顯示
- 訊息與金鑰的狀態機是否合理、流轉是否可重入
- 複寫日誌設計：seq 是否單調且不重用、store 是否 append-only 語義、重載後是否延續
- 現金儲值金的類比：**點數 = 應計負債**。發點是否只認共簽收據、雜湊鏈是否驗證、本地帳本與未來鏈上帳本的邊界
- 冪等性：同一訊息經 mesh 與 Firestore 備援雙路到達、回音、anti-entropy 補送，是否恰好一次
- 併發：多鄰居同時 gossip、rejoin 期間新舊連線並存、雙路收訊
- 金鑰分發的偽造、重放、亂序、降級（明文相容模式）風險
- Firestore rules：越權寫他人身分、擴權、房間人數上限繞過
- 效能與資源：輪詢、監聽器洩漏、IndexedDB 壓力（曾有 PrematureCommitError 前科）
- 日誌是否洩漏敏感內容（logger 脫敏）、可觀測性
- 測試、CI/CD 閘門、依賴與敏感資訊管理

## 特別關注（優先檢查會造成核心承諾破產的問題）

- 去重鍵失效：seq 碰撞（記憶體 fallback 路徑）、messageId 跨傳輸路徑不一致
- 跨會話重放：舊會話訊息在新會話被重新接受（已知殘留，確認範圍與影響）
- 加密降級：keyx 失敗時退明文相容，該狀態是否對使用者可見、是否會被利用
- 名冊瞬時不一致：keyx 名冊 = meshIdentities ∩ participants，形成期錯封/漏封金鑰
- 離開者殘留：leaveRoom 不即時清 meshIdentity，前向保密是否成立
- 備援明文：任何路徑把明文寫進 Firestore（含 metadata 洩漏評估：時間戳、成員、deps）
- 點數偽造：不經收據直接加點的程式路徑、收據重複入帳、單簽偽造共簽
- 簽章繞過：收端對無簽章或壞簽章訊息的處理是否 fail-closed
- rules 繞過：meshIdentities diff 檢查、memberStates 只能寫自己、admin 判定
- SDK 注入面：惡意 directory/signaling 實作能造成什麼（威脅模型：第三方後端本來就不可信，端上驗證是否自足）
- 對帳等式：寄出總數 = 收到 + 補送中 + 已墓碑（盲信使），是否有機制驗證

## 架構圖（必須根據實際程式碼與設定產生，不得虛構不存在的服務）

請使用 Mermaid 產生：

- 系統總體架構圖（分層：UI / SDK 門面 / core / 注入 adapter / Firebase）
- 訊息送收流程時序圖（含加密、簽章、gossip、去重、anti-entropy）
- 金鑰分發（keyx）時序圖
- 盲信使寄存與領取時序圖（含墓碑）
- 點數收據到入帳的流程圖
- 訊息與金鑰狀態圖
- 部署拓撲圖

## 風險格式

每項問題需包含：嚴重程度（Critical / High / Medium / Low）、所在模組、問題說明、
判斷證據（引用檔案路徑、類別、函式，不輸出完整原始碼）、可能影響（標明破壞哪條核心不變量）、
改善建議、修復優先級、信心程度（高 / 中 / 低）。

## 報告結構

1. 執行摘要
2. 評估範圍與限制
3. 技術棧與模組清單
4. 系統架構與架構圖
5. 核心流程（訊息 / 金鑰 / 盲信使 / 點數）
6. 不變量評估（恰好一次、E2EE、帳本、身分授權，各含成立條件與已知邊界）
7. 規則與權限評估
8. 效能、高可用與維運評估
9. 風險清單
10. 改善優先順序
11. CI/CD 閘門建議（每條可自動化的不變量對應一個 gate）
12. 最終結論

最終結論只能選擇：建議通過 / 有條件通過 / 不建議通過 / 資料不足，無法判斷。

## 脫敏要求

不得輸出：完整原始碼、API Key、Token、私鑰、連線字串、真實網域或個資、可直接利用的攻擊步驟。
缺乏證據的內容必須標示為「推論」或「尚未確認」。

## 輸出檔案

- docs/audit/core-invariants-assessment.md
- docs/audit/core-invariants-architecture.md
- docs/audit/core-invariants-risks.csv
