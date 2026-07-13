# Nerilo 核心不變量技術評估報告（脫敏版）

稽核日期：2026-07-13。對象：branch feature/p2c-keyx-live-mesh @ 957bb2c。
稽核框架：docs/audit/AUDIT-PROMPT-core-invariants.md。架構圖：core-invariants-architecture.md。
風險清單（機器可讀）：core-invariants-risks.csv。

## 1. 執行摘要

Nerilo 是 P2P 端到端加密即時通訊平台，核心承諾為四條不變量：訊息恰好一次、E2EE 機密性、
點數帳本正當性、身分與授權。本次稽核以「錯了等於真實損失」的標準檢視。

總體評價：核心路徑設計成熟，關鍵防護（收端驗簽 fail-closed、senderId 與 pubKey 綁定、
密文備援、rules 的 per-key diff 授權）皆有實作與測試背書；工程紀律良好（已知邊界在程式註解
與 ADR 中自我揭露）。主要風險集中在三處：跨會話重放的已知殘留（R1）、加密降級的明文相容
模式（R2）、CI 閘門偏軟（R8）。無 Critical 級發現。

**最終結論：有條件通過**。條件見第 11 節。

## 2. 評估範圍與限制

- 範圍：src/core（mesh/p2p/crypto/incentive/relay）、src/features/chat、src/services 中
  與不變量相關路徑、firestore.rules、.github/workflows、src/sdk。
- 限制：靜態審查 + 既有測試證據（unit 1369、e2e 套件、Stryker mutation 部分模組），
  未做滲透測試與長時間混沌實驗。多裝置同身分情境未在測試矩陣（標推論）。
- 本報告不輸出原始碼、金鑰、可利用攻擊步驟。

## 3. 技術棧與模組清單

TypeScript 5 嚴格模式。前端 Vue3/Nuxt（production 目標）與 React（凍結）。Firebase Auth +
Firestore（signaling、名冊、密文備援）。WebRTC DataChannel（主傳輸）。SubtleCrypto
（ECDSA P-256 身分、ECDH、AES-256-GCM）。Vitest + Playwright（emulator）。
核心模組：GossipMessageHandler（簽章/加密/去重/anti-entropy）、MeshTopologyManager（發現/
rejoin）、RoomKeyCoordinator（epoch 金鑰）、CourierStore/Service（盲信使）、CreditLedger +
CoSignedReceipt（點數）、SDK 門面（NeriloClient，四縫可注入）。

## 4. 系統架構

見 core-invariants-architecture.md（7 張 Mermaid 圖，依實碼繪製）。

## 5. 核心流程摘要

- 訊息：reserve-then-send 保留 seq（持久原子；失敗退記憶體遞增）、房間金鑰加密、簽章覆蓋
  密文、gossip 廣播、收端驗簽與 (senderId, seq) 去重、anti-entropy digest 對帳補送；
  覆蓋不足時走 Firestore 密文備援，同 messageId 跨路徑去重。
- 金鑰：keyx 名冊 = meshIdentities ∩ participants；epoch 輪替；離開者靠交集排除。
- 盲信使：密文寄存（簽章可驗不可解）、pull + 對帳、房籍簽章墓碑、共簽收據計量。
- 點數：信使簽 draft、requester 驗後共簽、verifyReceipt 雙簽驗證、CreditLedger 雜湊鏈入帳。

## 6. 不變量評估

### 6.1 訊息恰好一次：成立，附兩個已知邊界

成立機制：seq 持久保留不重用（GossipReplicaStore，記憶體計數器為會話真相）、收端
(senderId, seq) 去重含 store floor、anti-entropy 補送、跨傳輸路徑同 messageId 去重。
e2e 有「寄收兩端各恰好一次」黃金路徑與 3 人房多輪驗證。
邊界一（R1）：跨會話重放不受時效窗限制，程式註解自我揭露。
邊界二（R7）：reserveSeq 持久層失敗時退記憶體遞增，該 fallback 曾是掉訊根因（已修根因，
路徑仍存，觸發機率低）。

### 6.2 E2EE 機密性：主路徑成立，降級模式是最大缺口

成立機制：內容以房間金鑰（epoch sender key）加密；簽章覆蓋密文（盲信使可驗不可解）；
Firestore 備援僅寫密文（無金鑰則不送，靠 anti-entropy 補）；logger 遞迴遮罩敏感欄位。
缺口一（R2）：keyx 不可用時整房退明文相容，UI 有加密指示但屬被動告知；攻擊者若能阻斷
keyx（如選擇性丟包）即可誘導降級。
缺口二（R3）：名冊形成期瞬時不一致（程式檔尾自我揭露），可能短暫錯封/漏封。
缺口三（R6）：metadata 明文面：時間戳、成員、seq、deps（messageId 列表）對 Firestore
可見；relay 層有 padding 與 cover traffic，但房內 signaling 與備援的 metadata 不在其列。

### 6.3 點數帳本：密碼學層成立，帳本入口未強制收據

成立機制：收據需雙簽（信使 + requester），verifyReceipt 驗雙簽；CreditLedger 為雜湊鏈
append-only 日誌，餘額 = 重放 earn/spend；LocalCreditProvider 有每小時賺點上限（anti-cheat）。
缺口（R5）：Ledger.append 的 earn 不在型別與執行期強制附收據參照，正當性由呼叫端自律；
Phase 1 本地帳本設計如此（ADR-0020/0022 自我揭露），但升鏈上/伺服器仲裁前，本地餘額
不可作為跨節點清算依據。

### 6.4 身分與授權：成立

收端對壞簽章 fail-closed（丟棄 + peerScoring 記負分）；pubKey 與 senderId 綁定驗證
（防用自己的 key 冒他人 id）；firestore.rules 以 diff().affectedKeys().hasOnly([auth.uid])
限制 meshIdentities 只能寫自己那個 key；memberStates 每人只能寫自己文件；房間人數上限
在 rules 硬擋。SDK 注入面威脅模型合理：第三方後端本來就不可信，簽章/加密/去重全在端上，
惡意 directory/signaling 至多造成可用性問題，不能偽造內容或身分（推論：未做惡意 adapter
的專項測試，建議補，見 R10）。

## 7. 規則與權限評估

rules 有正向測試（emulator）。admin 以 custom claim 判定。未發現越權寫路徑。
人工調帳類比（後台補點）目前不存在伺服器端點數，故無 maker-checker 議題；若未來上
伺服器帳本需補。

## 8. 效能、高可用與維運

- 已知並已處理：IndexedDB 高壓下 PrematureCommitError（reserveSeq 改記憶體真相 + 非阻塞
  持久化）；rejoin 最壞延遲 46s → 12s 中位。
- 殘留：mesh 內部無 push 事件，連線狀態靠 2s 輪詢 + 1s busRebindWatch（成本低但屬技債）；
  Firebase 為 signaling/發現的可用性單點（SDK 注入縫已開，產品面仍單一後端）（R9）。
- 可觀測性：logger 分級 + 遮罩；ConnectionStats 有直連/fallback 統計；無集中告警（推論：
  規模尚小，暫可接受）。

## 9. 風險清單

完整欄位見 core-invariants-risks.csv。摘要（無 Critical）：

| ID | 嚴重度 | 模組 | 一句話 | 破壞的不變量 |
|----|--------|------|--------|--------------|
| R1 | High | GossipMessageHandler | 跨會話重放不受時效窗，舊簽章訊息可在新會話被重新接受 | 恰好一次 |
| R2 | High | MeshGossipManager/keyx | keyx 失敗退明文相容，降級可被誘導且僅被動告知 | E2EE |
| R3 | Medium | RoomKeyCoordinator | 名冊形成期瞬時不一致，短暫錯封/漏封金鑰 | E2EE |
| R4 | Medium | RoomService/rules | 離開者 meshIdentity 殘留，前向保密依賴交集與輪替 | E2EE |
| R5 | Medium | CreditLedger | earn 不強制收據參照，正當性靠呼叫端自律 | 帳本 |
| R6 | Medium | Firestore metadata | 時間戳/成員/deps 明文，流量分析面未涵蓋房內路徑 | E2EE(metadata) |
| R7 | Medium | GossipReplicaStore | reserveSeq 持久失敗退記憶體遞增，fallback 路徑仍存 | 恰好一次 |
| R8 | Medium | CI | e2e stable 與 npm audit 皆軟閘，迴歸不擋 merge | 全部(制度面) |
| R9 | Low | 架構 | Firebase 為 signaling/發現可用性單點 | 可用性 |
| R10 | Low | SDK | 惡意 adapter 專項測試缺席（端上驗證推論自足，未實證） | 身分/授權 |

## 10. 改善優先順序

1. R8：CI 硬閘化（本次稽核同步實作：SDK 隔離 gate 上線；e2e stable 建議觀察穩定後翻硬閘）。
2. R1：跨會話重放收斂（方向：per-session epoch 或 store floor 持久化跨會話延續）。
3. R2：降級策略改 fail-visible（明文模式需使用者明確確認，或預設拒送）。
4. R5：Ledger earn 型別上強制 receiptRef，verify 在 append 內做。
5. R3/R4：名冊收斂與離開清理（epoch 輪替觸發即時化）。
6. R6：metadata 最小化評估（屬長期工程，先文件化威脅模型）。

## 11. 上線前驗收條件（有條件通過的條件）

1. CI 有硬閘：type-check、lint、unit、SDK 隔離檢查必須全綠才可 merge（本次實作）。
2. e2e stable 套件連續兩週綠 → 翻 continue-on-error: false。
3. R1 有明確處置決策（修復或風險接受並記錄於 ADR）。
4. R2 降級行為文件化並在 UI 提升為顯性警告。
5. 對外發佈 SDK 前，R10 惡意 adapter 契約測試補齊。

## 12. 最終結論

**有條件通過**。核心不變量在主路徑上成立且有測試背書，已知缺口均已自我揭露且有收斂路徑；
條件集中在制度面（CI 硬閘）與兩個 High 級技術殘留（R1/R2）的處置決策。
