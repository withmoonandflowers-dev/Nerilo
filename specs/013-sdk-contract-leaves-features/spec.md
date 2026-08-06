# Spec 013：把 SDK 公開契約搬出 src/features

- 軌別：feature
- 狀態：done
- 建立：2026-07-25／最後更新：2026-07-25
- 關聯：ADR-0025（可嵌入 SDK：公開表面只有 src/sdk/index.ts）、ADR-0031（死重圍籬先例）、憲法第 7 條（邊界靠工具強制）、docs/PROMPT-architecture-convergence.md §②④⑥

## 1. 要做什麼、為什麼（specify）

第三方嵌入者只該依賴「地基」。但目前 `src/sdk/index.ts` 有三組公開匯出（`reactions`、
`readReceipts`、`messageContent`）的實作放在 `src/features/chat/`，也就是 React 參考應用的目錄底下。
於是公開契約在檔案層相依於應用層：嵌入者讀型別會被導向 features/、`src/sdk` 的 import 圖穿過應用層目錄，
而 ADR-0017 之後 React 產線是要退役的，退役時會踩到「刪應用層等於刪公開契約」。

把三組純邏輯搬進 `src/core/messaging/`，讓公開契約完全落在地基內。**公開表面一個字都不變**
（匯出名稱、型別、行為全等），純粹是實作位置與 import 路徑的搬遷。

再補上機器圍籬：現行 ESLint 的「後端不得依賴前端 UI 層」只涵蓋 `src/core/**` 與 `src/services/**`，
`src/sdk/**` 不在名單內，這正是本次違規能長出來的原因。把 `src/sdk/**` 納入同一條圍籬，
讓它不會慢慢爛回去。

**憲法檢核**（constitution.md）：
- 目標函數加分項：**可嵌入**（公開契約不再拖著應用層）、**可維運**（React 退役時契約不受牽連）。
- 四條不變量影響：恰好一次〈無影響：不碰傳輸與去重〉；E2EE〈無影響：不碰加密路徑，
  `messageContent` 的「回覆標記進密文」語義原樣搬移〉；帳本正當性〈無影響〉；身分授權〈無影響〉。

## 2. 邊界（明確不做）

- 不改任何公開匯出的名稱、簽章、型別或行為；`sdkSurface` 測試必須零變更通過。
- 不動 `MeshChatService`、`ChatService`、`encryptionGate`、`fallbackDecrypt` 等其餘 features/chat 內容（它們不是公開契約）。
- 不順手重構這三支的內部實作（搬移就是搬移，混改會讓 review 失去意義）。
- 不處理 web-vue 側的 ESLint 圍籬（ADR-0031 已列 follow-up，不在本 spec 擴張）。
- 不動 React 產線的存廢（那是 ADR-0017 的事）。

## 3. 待釐清（clarify）

無。需求無歧義：搬移位置＋補圍籬，公開表面不變。技術取捨（落點命名）記於第 4 節。

## 4. 技術計畫（plan）

**落點：`src/core/messaging/`**，收 `reactions.ts`、`readReceipts.ts`、`messageContent.ts` 三檔。

為何不是 `src/core/chat/`：Nerilo 的定位是「層不是 App」（憲法第 1 條），核心目錄裡出現 `chat`
會把參考應用的名字寫進地基。這三支的實質是「訊息層語義」（表情聚合、已讀水位、回覆編碼），
一律建立在傳輸層之上、與 UI 無關，`messaging` 精準且不綁應用。

為何不是留原地只加 re-export：那只是把違規藏起來，import 圖照樣穿過 features/，React 退役時照樣踩雷。

**動到的模組**：
- 新增 `src/core/messaging/{reactions,readReceipts,messageContent}.ts`（內容原樣，僅修 `readReceipts` 對 `types` 的相對路徑）。
- 改 import 路徑：`src/sdk/{index,IChatEngine,NeriloClient}.ts`、`mcp/inProcessEngine.ts`、
  `src/features/chat/MeshChatService.ts`、`web-vue/app/{lib/chatDerive.ts,pages/dashboard.vue,pages/chat/[roomId].vue}`、
  四支單元測試。
- `.eslintrc.cjs`：新增 `src/sdk/**/*.ts` 專屬圍籬區塊（適應度函數，防回退）。

**資料/格式變更**：無。線上格式、儲存格式、協議皆不動。

〔實作期修訂〕圍籬的兩個坑，都是實測才浮現的：

1. **ESLint override 是覆寫不是合併**。原計畫把 `src/sdk/**` 併進既有的「前後端合約」區塊，
   但檔尾另有一個 PARK 圍籬區塊也涵蓋 `src/sdk/**`，後者整組蓋掉前者的 `no-restricted-imports`，
   結果 UI 層 pattern 對 sdk 完全失效，設定改了、規則沒生效。改法：把 sdk 從那兩個區塊移出，
   在檔尾開一個專屬區塊，**同時列全** UI 層與 PARK 兩組 pattern。
2. **`no-restricted-imports` 射程不含動態 `import()`**。`src/sdk/firestore.ts` 對
   `MeshChatService` 的 `await import()` 規則根本抓不到（一開始加的 `eslint-disable` 反而被
   `--report-unused-disable-directives` 判定為無用而報錯）。改為就地留註解說明它是靠自律不是靠機器，
   不假裝圍籬涵蓋它。這也是本 spec 唯一的已知殘留。

**已知殘留**：~~`MeshChatService`（mesh 聊天引擎本體）仍在 `src/features/chat/`~~
**已於 2026-07-26 收斂**（不必等 ADR-0017）：`MeshChatService`、`encryptionGate`、
`fallbackDecrypt` 三檔已搬進 `src/core/messaging/`，SDK 不再有任何路徑（含動態 import）
穿過 `src/features`。

同時補上本 spec 當時明確承認擋不住的那個缺口：`tests/unit/fitness.architecture.spec.ts`
新增動態 import 掃描，涵蓋 `src/sdk`／`src/core`／`src/services`。探針驗證，把
SDK 的動態 import 改回 `../features/chat/MeshChatService`，測試立刻紅並指名該行。
ESLint 射程外的部分，現在由這組測試接手。

## 5. 任務分解（tasks）

- [x] T1：`git mv` 三檔進 `src/core/messaging/`，修 `readReceipts` 內部對 `types` 的相對路徑。
- [x] T2：更新全部 import 端（src/sdk、mcp、features/chat/MeshChatService、web-vue 三處、四支測試）。
- [x] T3：`.eslintrc.cjs` 前後端合約圍籬納入 `src/sdk/**/*.ts`。
- [x] T4：分層閘門逐層綠（type-check → 受影響單元 → 全單元 → lint → build:sdk → nuxt typecheck）。

註：本 spec 不含 ⚠ 任務，三支皆為無相依副作用的純函數，搬移不改行為，
既有單元測試（reactions／readReceipts／messageContent／neriloClient）即為 characterization 現況鎖。

## 6. 驗收（黃金判準）

- [x] V1 公開表面零變更：`tests/unit/sdkSurface.spec.ts` 未改一行仍綠（它鎖的是 `src/sdk/index.ts` 的匯出清單）。
- [x] V2 行為零變更：`reactions.spec.ts`／`readReceipts.spec.ts`／`messageContent.spec.ts`／`neriloClient.spec.ts`
      僅改 import 路徑、斷言未動，全綠。
- [x] V3 全單元基線不退：137 檔／1544 tests 全綠。
- [x] V4 圍籬真的會擋：`src/sdk/**` 納入圍籬後 lint 仍 0 error（7 warnings，與基線同）；
      且在 `src/sdk/` 放一支只有 `import '../features/chat/ChatService'` 的探針檔時，
      ESLint 確實報 `no-restricted-imports` 並印出本 spec 的訊息，exit=1（驗畢即刪）。
      **這條驗收救了本 spec**：第一版設定看起來對，探針卻靜默通過，才挖出 override 覆寫問題。
- [x] V5 兩條產線與 SDK 打包不破：`npm run build:sdk` 通過、`nuxt typecheck` 通過。

## 7. 一致性自查（analyze，implement 前跑一次）

- [x] 第 4 節方案覆蓋第 1 節全部需求，無多做：需求＝契約脫離應用層（T1/T2）＋不再長回來（T3）；無其他改動。
- [x] 第 5 節任務完整實現第 4 節，無遺漏：三個落點檔、九處 import、一條圍籬、一組閘門，逐一對得上。
- [x] 第 6 節驗收能證明第 1 節，不是只證明「程式跑得動」：V1 證明契約沒被動到（這是本 spec 最大的風險），
      V4 用「刻意違規要報錯」證明圍籬有效而非只是設定檔改了字，兩者都不是「跑得動」等級的驗收。
- [x] 未違反憲法任何一條：第 7 條（邊界靠工具強制）正是本 spec 落實的對象；四條不變量皆宣告無影響。
