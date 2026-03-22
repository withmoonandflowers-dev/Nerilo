## 變更說明

（簡短說明此 PR 的目的與主要變更）

## 問題編號（若有）

關聯 Issue：#

## 檢查清單（請在合併前確認）

- [ ] 已執行 `npm run type-check` 且通過
- [ ] 已執行 `npm run lint` 且通過
- [ ] 已執行 `npm run test:run` 且單元測試全部通過
- [ ] 若變更影響房間/聊天/等待頁/Firestore：已跑相關 E2E 或手動驗證
- [ ] 若涉及 Firestore 規則、Auth、環境變數、依賴升級：已由人工審核（見 [AI協作規範](docs/AI協作規範.md)）

## 上板

- [ ] 本 PR 合併後將／不會觸發自動部署（依 [CI](.github/workflows/ci.yml) 設定）
- [ ] 若需手動上板：合併後執行 `npm run deploy` 或 `.\scripts\deploy.ps1 -Check`
