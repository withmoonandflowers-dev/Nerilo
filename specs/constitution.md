# Nerilo 專案憲法

規格驅動開發的最高裁決文件。所有 spec、plan、實作與審查以此為準。本檔是**彙整點不是新規則**：每條都註明源頭，源頭改了此檔要跟著改。

## 一、產品憲法（為什麼存在）

1. **定位是層，不是 App**：可嵌入的韌性通訊層，不跟 Signal/LINE 搶使用者。（docs/pitch/positioning-differentiation.md）
2. **隱私與韌性不可妥協**：內容不經伺服器明文、中央掛了也要能通。任何 spec 若違反此條，直接否決。（ADR-0009、威脅模型）
3. **變現走補助/競賽 + open-core**，不融資、不衝訂閱。新功能先問：對「補助競爭力 × 可維運 × 可嵌入 × 隱私韌性」哪個係數加分？不加分的不做。（nerilo-strategy）

## 二、工程憲法（怎麼做事）

4. **四條核心不變量高於一切功能**：訊息恰好一次、E2EE 機密性、點數帳本正當性、身分與授權。任何 spec 必須聲明它對這四條的影響（含「無影響」也要寫）。（docs/audit/core-invariants-assessment.md）
5. **誠實條款**：不准加長 timeout 硬湊綠；改動讓事情變糟就回退；紅的釘住測試＝停止號誌。（.claude/skills/harden-tests）
6. **改運作中路徑必走 characterization-first**：先釘現況再改，分層閘門（type-check→受影響單元→全單元→受影響 E2E→ci）逐層綠。（harden-tests）
7. **邊界靠工具強制**：core 不得 import features/UI（ESLint no-restricted-imports）；領域層零框架依賴；SDK 公開表面只有 `src/sdk/index.ts` 匯出的東西。（ADR-0025）
8. **架構決策落 ADR**：只寫看 diff 看不出來的理由與取捨，動詞開頭。spec 的重大取捨完成後要回填 ADR。（ADR-0001、CLAUDE.md）
9. **黃金測試是回歸底線**：關鍵流程以固定資料集回歸（golden-path、mesh-diagnostic 矩陣、React 護欄），spec 的驗收必須落到可執行的測試。
10. **已知邊界自我揭露**：做不到的、暫時妥協的，寫進程式註解與風險登記，不藏。（docs/audit/core-invariants-risks.csv）

## 三、文件憲法（怎麼寫字）

11. **台灣用語**：介面/資料/程式碼/專案/佇列/快取；嚴禁簡體用詞。
12. **對外文件去AI感**：禁 em-dash、emoji、口號式排比；引用數字必須核對過真實資料。（outgoing-content 慣例）
13. **commit 風格**：`[<branch>] 動詞開頭一句話 ≤70 字` + 至多 3 行非顯而易見的 context；不加 AI 署名。（CLAUDE.md 全域）

## 四、規格憲法（spec 本身的規矩）

14. **先 spec 後實作**：會動到核心不變量、公開 SDK 表面、協議格式、或跨兩個以上模組的工作，先寫 spec；小修小補不必（判準：一句話講得清楚且不碰上述四類 → 免 spec）。
15. **雙軌規格**：`feature`（單一實作內的功能）與 `protocol`（跨實作互通的協議層）。協議軌的變更視同公開 API 破壞性變更管理，必須含版本與相容策略。
16. **spec 是活文件**：實作中發現 spec 錯了，改 spec 並標記，不默默偏離。
