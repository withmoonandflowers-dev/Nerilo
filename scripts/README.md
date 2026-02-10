# 測試與建置執行腳本說明

本目錄提供可重複執行的腳本，用於本機或 CI 環境跑單元測試、E2E 測試與建置。  
詳細測試流程與需求對照請見 [docs/完整測試流程.md](../docs/完整測試流程.md)。

## 環境需求

- Node.js（建議 v18+）
- 專案根目錄已執行過 `npm install`
- E2E 會自動啟動 `npm run dev:test`（port 4173），無需手動起 server
- 依賴 WebRTC / Firebase 的 E2E 需可連線至 Firebase 專案（或使用 Emulator）

## 腳本一覽（Windows PowerShell）

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
| 快速 E2E | `npm run test:e2e -- tests/e2e/waiting-room.spec.ts ...` |
| 全部 E2E | `npm run test:e2e` |
| 單元 | `npm run test:run` |

腳本內皆會先 `cd` 到專案根目錄再執行，確保路徑與環境一致。
