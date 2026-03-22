# 系統改進與 AI 協作手冊

本文件說明：**目前系統待改進項目**、**CI/CD 與問題修正流程**、**如何與 AI 協作以產出穩定且符合資安的產品**。

---

## 一、目前系統待改進項目

### 1.1 CI/CD

| 項目 | 現狀 | 建議 |
|------|------|------|
| 品質門檻 | 僅跑 E2E，未先跑 type-check / lint / 單元測試 | 先跑 type-check、lint、單元測試、`npm audit`，通過後再跑 E2E |
| E2E 穩定性 | 全量 E2E 依賴 WebRTC/Firebase，CI 易失敗 | 分階：必跑「不依賴已連線」的 E2E；依賴連線的改為可選或較長超時 |
| 安全掃描 | 無 | 加入 `npm audit`（可設定 audit-level）、依需求加入 dependency 掃描 |
| 部署自動化 | 無 | 可選：main 分支通過後自動 deploy hosting（使用 GitHub Secrets 的 FIREBASE_TOKEN） |
| 分支策略 | 觸發為 main / develop | 可加 protect branch 要求 PR 通過 CI |

### 1.2 資安

| 項目 | 現狀 | 建議 |
|------|------|------|
| Firebase 設定 | 程式內有 fallback 預設值（API key 等） | 正式環境改為僅用環境變數，無則 build 失敗或明確標示非正式環境 |
| 環境變數 | 有 env.example，.env 已 ignore | 維持；CI 用 GitHub Secrets 注入，絕不 commit 真實 key |
| Hosting 安全頭 | 未設定 | 在 firebase.json 加上 X-Content-Type-Options、X-Frame-Options、Referrer-Policy 等 |
| 依賴漏洞 | 未在 CI 檢查 | 以 `npm audit` 在 CI 擋下高/嚴重漏洞 |

### 1.3 問題發現與修正流程

| 項目 | 現狀 | 建議 |
|------|------|------|
| 問題分級 | 無明確定義 | 定義 P0/P1/P2，與「是否擋 deploy」掛鉤 |
| 修正 SOP | 分散在各 doc | 收斂成單一「問題修正流程」：重現 → 分級 → 修復 → 測試 → 上板 |
| 回歸範圍 | 手動決定 | 依改動範圍決定：單元 / E2E 子集 / 全量 E2E |

---

## 二、CI/CD 改進方案（已落實或可選）

### 2.1 建議流程

1. **品質門檻（必跑）**  
   `type-check` → `lint` → `npm audit`（可設 `--audit-level=high`）→ `單元測試`。任一步失敗即視為 CI 失敗。
2. **E2E（分階）**  
   - 必跑：不依賴「已連線」的 E2E（例如 waiting-room、room-timeout、room-closed 部分案例）。  
   - 可選：全量 E2E 或依賴 WebRTC 的案例，可放在獨立 job、較長超時或手動觸發。
3. **部署（可選）**  
   main 分支、品質門檻 + 必跑 E2E 通過後，以 `firebase deploy --only hosting --token "$FIREBASE_TOKEN"` 部署；FIREBASE_TOKEN 存於 GitHub Secrets。

### 2.2 與現有檔案的對應

- 品質門檻與 E2E 分階：見 `.github/workflows/ci.yml`（新建）或擴充現有 `e2e-tests.yml`。
- 上板指令與手動流程：見 [上板與部署手冊](上板與部署手冊.md)。

---

## 三、問題修正流程（建議）

### 3.1 分級

- **P0**：生產不可用（例如登入掛掉、無法建立房間）、資安漏洞。→ 擋上板、優先修。
- **P1**：功能異常或明顯錯誤，但有替代方式。→ 建議修完再上板。
- **P2**：體驗或次要問題。→ 排期修。

### 3.2 標準步驟

1. **重現**：用 issue/描述或自動化步驟重現。
2. **分級**：標記 P0/P1/P2。
3. **修復**：在功能分支修改，遵循 [新功能接入SOP](新功能接入SOP.md) 與底下「AI 協作規範」。
4. **驗證**：  
   - 必做：`npm run type-check`、`npm run lint`、`npm run test:run`。  
   - 依改動：跑相關 E2E 或手動情境。
5. **合併與上板**：PR 通過 CI 後合併；上板依 [上板與部署手冊](上板與部署手冊.md)。

### 3.3 與 AI 協作時

- 把「重現步驟」與「預期/實際行為」寫清楚，再請 AI 建議修改或產生 patch。
- 修完後**一定**由人類執行或確認：type-check、lint、單元測試、必要 E2E。
- 若 AI 建議改 Firestore 規則或權限，需人工 review 後再上線。

### 3.4 快速對照：有問題時怎麼開始修

1. **能重現嗎？** → 能：記下步驟或寫成 test case；不能：先加日誌或縮小範圍。
2. **嚴重度？** → P0：立刻修、擋上板；P1：本週修；P2：排 backlog。
3. **修完驗證** → 必跑：`npm run type-check && npm run lint && npm run test:run`；再依改動跑 E2E 或手動測。
4. **合併與上板** → PR 通過 CI 後合併；上板用 `npm run deploy` 或 `.\scripts\deploy.ps1 -Check`。

---

## 四、如何與 AI 協作產出穩定且符合資安的產品

### 4.1 原則

- **AI 產出必須經過門檻**：型別、Lint、單元測試、必要 E2E 都要過，不能跳過。
- **敏感與權限人類把關**：環境變數、Firestore 規則、API 權限、CSP 等，由人審核後再部署。
- **可重現與可回滾**：變更要有清楚說明或 commit message；重要上板前確認可回滾（例如保留上一版 hosting）。

### 4.2 建議的 AI 使用方式

| 情境 | 建議做法 |
|------|----------|
| 修 bug / 小功能 | 提供重現步驟與檔案，請 AI 改程式；你跑 type-check、lint、test:run 與相關 E2E。 |
| 新功能 | 依 [新功能接入SOP](新功能接入SOP.md) 設計；AI 可協助實作與單元測試，你負責規則與權限 review。 |
| 重構 | 分小步、每步都有測試；AI 可建議拆法與補測試，你決定範圍與上板時機。 |
| Firestore / 權限 / 環境變數 | AI 可建議規則或範例，**實際變更與上線由人審核**。 |
| 依賴升級 | AI 可協助適配；你跑完整測試與 `npm audit` 後再合併。 |

### 4.3 Cursor / 專案內規範（給 AI 與人共用）

- 專案內已提供 **`.cursor/rules/ai-and-security.mdc`** 與 **`docs/AI協作規範.md`**，包含：  
  - 改程式後必須通過 type-check、lint、單元測試。  
  - 不允許把真實 API key / secret 寫進程式或 commit。  
  - 改 Firestore 規則、auth、環境變數需由人類審核後再合併/上板。

---

## 五、本手冊與其他文件對應

| 主題 | 文件 |
|------|------|
| 上板指令與流程 | [上板與部署手冊](上板與部署手冊.md) |
| 測試範圍與流程 | [完整測試流程](完整測試流程.md) |
| 新功能開發 | [新功能接入SOP](新功能接入SOP.md) |
| 驗證與 Push | [驗證與Push說明](驗證與Push說明.md) |
| AI 與 Cursor 規範 | 本手冊 §四、§六；`.cursor/rules` 或 `docs/AI協作規範.md` |

---

## 六、後續可補強項目（舉一反三）

- **Dependency 掃描**：整合 Dependabot 或 Snyk，對高/嚴重漏洞自動開 issue 或擋合併。  
- **CSP 精細化**：依實際需求調整 `Content-Security-Policy`，平衡安全與第三方腳本。  
- **日誌與監控**：生產環境錯誤上報（例如 Firebase Crashlytics），方便發現問題並納入修正流程。  
- **自動化回歸清單**：依模組/檔案變更自動建議要跑的 E2E 或手動情境，方便與 AI 協作時不遺漏。

以上流程與 AI 協作方式，可隨團隊習慣微調，但**品質門檻與資安審核由人把關**的原則建議維持。
