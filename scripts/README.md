# 測試與建置執行腳本說明

本目錄提供可重複執行的腳本，用於本機、CI 環境，以及 **Cowork 直接呼叫**。
每個指令同時提供 `.sh`（macOS / Linux / Cowork sandbox）與 `.bat`（Windows）兩種版本。

詳細測試流程與需求對照請見 [docs/完整測試流程.md](../docs/完整測試流程.md)。文件索引見 [docs/README.md](../docs/README.md)。

## Cowork 可直接呼叫的腳本（sh + bat）

| 腳本 | 用途 | Cowork 呼叫方式 |
|------|------|----------------|
| `check.sh` | type-check + 單元測試（品質門檻） | `bash scripts/check.sh` |
| `check.sh --lint` | 同上，加入 ESLint | `bash scripts/check.sh --lint` |
| `test.sh` | 僅執行單元測試 | `bash scripts/test.sh` |
| `test.sh --watch` | 監聽模式（開發用） | `bash scripts/test.sh --watch` |
| `test-coverage.sh` | 單元測試 + HTML coverage 報表 | `bash scripts/test-coverage.sh` |
| `build.sh` | 建置前端（tsc + vite build） | `bash scripts/build.sh` |
| `build.sh --check` | 先品質門檻再 build | `bash scripts/build.sh --check` |
| `git-commit-fixes.sh` | 提交本輪 bug fixes | `bash scripts/git-commit-fixes.sh` |
| `git-commit-tests.sh` | 提交本輪新增測試與腳本 | `bash scripts/git-commit-tests.sh` |

### Windows 使用者

將上方 `.sh` 替換為 `.bat`，在命令提示字元或 PowerShell 執行即可：

```bat
scripts\check.bat
scripts\test.bat
scripts\test-coverage.bat --open
scripts\build.bat --check
scripts\git-commit-fixes.bat
scripts\git-commit-tests.bat
```

## 環境需求

- Node.js（建議 v18+）
- 專案根目錄已執行過 `npm install`
- E2E 會自動啟動 `npm run dev:test`（port 4173），無需手動起 server
- 依賴 WebRTC / Firebase 的 E2E 需可連線至 Firebase 專案（或使用 Emulator）

## 腳本一覽（Windows PowerShell）

### 部署／上板

| 腳本 | 用途 |
|------|------|
| `deploy.ps1` | 建置 + `firebase deploy --only hosting` |
| `deploy.ps1 -Check` | 先 type-check、lint、單元測試，通過後再 build + deploy hosting |
| `deploy.ps1 -Full` | 建置 + `firebase deploy`（hosting + firestore + functions） |
| `deploy-safe.ps1` | 等同 `deploy.ps1 -Check`（安全上板） |

詳見 [docs/上板與部署手冊.md](../docs/上板與部署手冊.md)。歷史文件已清理，若需還原可參考 `scripts/cleanup-removed-docs.bat` 中的刪除清單。

### 品質門檻（與 CI 一致）

| 腳本 / 指令 | 用途 |
|-------------|------|
| `.\scripts\check.ps1` | type-check、單元測試（一鍵，等同 `npm run ci:fast`；通過再 push/PR） |
| `npm run ci:fast`、`npm run check` | 同上，不依賴 PowerShell |
| `npm run ci` | 完整門檻（含 lint），與 CI 一致 |

### 測試

| 腳本 | 用途 | 預估時間 |
|------|------|----------|
| `test-e2e-quick.ps1` | E2E 快速回歸（不含 Mesh，含需連線的 2 人測試） | ~2–4 min |
| `test-e2e-full.ps1` | E2E 完整套件（含 comprehensive、architecture、mesh） | ~8–15 min |
| `test-e2e-all.ps1` | 全部 E2E 測試 | ~10–18 min |
| `run-all-tests.ps1` | 單元測試 + 全部 E2E（一鍵） | ~12–20 min |

## 使用方式

在專案根目錄執行（PowerShell）：

```powershell
# 快速 E2E 回歸
.\scripts\test-e2e-quick.ps1

# 完整 E2E（含 Mesh、comprehensive）
.\scripts\test-e2e-full.ps1

# 全部 E2E
.\scripts\test-e2e-all.ps1

# 單元 + 全部 E2E
.\scripts\run-all-tests.ps1

# 上板（僅 Hosting）
.\scripts\deploy.ps1

# 安全上板（先檢查再部署）
.\scripts\deploy.ps1 -Check
.\scripts\deploy-safe.ps1

# 品質門檻（push/PR 前建議執行）
.\scripts\check.ps1
# 或：npm run ci
```

或從任意目錄指定專案根：

```powershell
& "d:\cursor\Nerilo\scripts\test-e2e-quick.ps1"
```

## 注意事項

1. **依賴 WebRTC 的測試**：`user-chat.spec.ts`、`room-management.spec.ts` 中「兩個使用者連線並傳訊息」依賴 WebRTC P2P 與 Firebase。在網路或 CI 環境不穩時可能逾時，可參考 [docs/完整測試流程.md §5.1](../docs/完整測試流程.md) 處理。
2. **超時**：Mesh 相關測試已使用較長超時（例如 120s）；若仍失敗，可於腳本內調整 `--timeout`。
3. **僅跑單元測試**：使用 `npm run test:run` 或 `npm run test`。

## 與 npm scripts 對應

| 腳本行為 | 對應 npm 指令 |
|----------|----------------|
| 上板（Hosting） | `npm run deploy` 或 `npm run build && firebase deploy --only hosting` |
| 安全上板（檢查+部署） | `npm run deploy:safe` |
| 品質門檻（type-check + lint + 單元測試） | `npm run ci` 或 `npm run check` |
| 快速 E2E | `npm run test:e2e -- tests/e2e/waiting-room.spec.ts ...` |
| 全部 E2E | `npm run test:e2e` |
| 單元 | `npm run test:run` |

腳本內皆會先 `cd` 到專案根目錄再執行，確保路徑與環境一致。
