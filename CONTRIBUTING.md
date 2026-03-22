# 貢獻流程（Nerilo）

感謝參與專案。請依下列流程回報問題、提出功能、或提交程式變更，以維持穩定與資安。

---

## 1. 回報問題

- 開 Issue 時請使用 **問題回報** 範本（[.github/ISSUE_TEMPLATE/bug_report.md](.github/ISSUE_TEMPLATE/bug_report.md)）。
- 填寫 **重現步驟**、**預期／實際行為**、**嚴重度（P0/P1/P2）**，方便排程與修復。
- 嚴重度定義見 [系統改進與AI協作手冊 § 三、問題修正流程](docs/系統改進與AI協作手冊.md)。

---

## 2. 提出功能建議

- 可使用 **功能建議** 範本（[.github/ISSUE_TEMPLATE/feature_request.md](.github/ISSUE_TEMPLATE/feature_request.md)）。
- 新功能實作可參考 [新功能接入SOP](docs/新功能接入SOP.md)。

---

## 3. 提交程式變更（PR）

1. **分支**：自 `main` 或 `develop` 開分支進行修改。
2. **門檻**：合併前必須通過：
   - `npm run type-check`
   - `npm run lint`
   - `npm run test:run`
   - 若改動影響房間/聊天/等待頁/Firestore：跑相關 E2E 或手動驗證。
3. **一鍵檢查**：可在本機執行與 CI 一致的門檻：
   ```bash
   npm run ci
   ```
   或（PowerShell）：
   ```powershell
   .\scripts\check.ps1
   ```
   若專案尚有 lint 警告未清完，可先執行 `npm run ci:fast`（僅 type-check + 單元測試）再送 PR；CI 仍會跑完整 `npm run ci`。
4. **PR 範本**：開 PR 時請依 [.github/PULL_REQUEST_TEMPLATE.md](.github/PULL_REQUEST_TEMPLATE.md) 填寫說明與檢查清單。
5. **資安**：若變更 Firestore 規則、Auth、環境變數、依賴升級，需經人工審核，見 [AI協作規範](docs/AI協作規範.md)。

---

## 4. 與 AI 協作時

- 變更後**必須**通過上述門檻；敏感與權限相關變更由**人**審核後再合併。
- 詳見 [系統改進與AI協作手冊](docs/系統改進與AI協作手冊.md) 與 [AI協作規範](docs/AI協作規範.md)。

---

## 5. 上板與部署

- 上板指令與流程見 [上板與部署手冊](docs/上板與部署手冊.md)。
- 建議正式上板前執行：`npm run deploy:safe` 或 `.\scripts\deploy.ps1 -Check`。

---

## 6. 相關文件速查

| 主題 | 文件 |
|------|------|
| 問題修正流程、CI/CD、AI 協作 | [系統改進與AI協作手冊](docs/系統改進與AI協作手冊.md) |
| AI 協作與資安紅線 | [AI協作規範](docs/AI協作規範.md) |
| 上板與部署 | [上板與部署手冊](docs/上板與部署手冊.md) |
| 測試流程 | [完整測試流程](docs/完整測試流程.md) |
| 新功能開發 | [新功能接入SOP](docs/新功能接入SOP.md) |
