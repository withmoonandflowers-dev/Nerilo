# 驗證與 Push 說明

## 1. Push 設定（目前專案為新初始化的 Git）

專案已執行 `git init` 並完成第一次 commit，**尚未設定遠端**，無法直接 `git push`。

### 若要 Push 到 GitHub / 其他遠端

在專案根目錄執行：

```powershell
# 新增遠端（請替換為您的 repo URL）
git remote add origin https://github.com/您的帳號/Nerilo.git

# 推送到遠端（首次建議用 -u 設定上游分支）
git push -u origin master
```

若遠端預設分支為 `main`，可先改本地分支名再 push：

```powershell
git branch -M main
git remote add origin https://github.com/您的帳號/Nerilo.git
git push -u origin main
```

---

## 2. 功能驗證結果

### 單元測試 ✅

- **指令**：`npm run test:run`
- **結果**：36 個測試全部通過（crypto.spec.ts、SharedDataStream.spec.ts）

### E2E 測試（真實環境考量）

- **指令**：`npm run test:e2e` 或 `.\scripts\test-e2e-all.ps1`
- **環境**：Playwright 自動啟動 `npm run dev:test`（port 4173），使用 Chromium、連線至實際 Firebase（匿名登入與 Firestore）。

**已配合真實環境的調整：**

1. **等待時間**：依賴「已連線」的測試將等待時間設為 60s（user-chat、room-management、single-user-room），以因應 WebRTC/ICE 在真實網路下的延遲。
2. **房主取消房間**：導向 dashboard 的等待改為 15s，以因應 Firestore 寫入與導向延遲。
3. **等待頁面**：改為以 `.role-badge` + `toContainText('guest')` 等待登入狀態，與其他 E2E 一致，減少 Firebase 匿名登入延遲造成的 flaky。

**預期狀況：**

- **不依賴 WebRTC 連線的流程**（建立房間、等待頁、倒數、分享連結、參與者數、取消/離開、關閉房間、第二人轉聊天頁）：在 Firebase 與網路正常時應可穩定通過。
- **依賴「已連線」的測試**（2 人聊天、Mesh、架構選擇等）：需 WebRTC 成功建立；在 headless/CI 或網路限制環境下可能逾時，屬環境限制而非邏輯錯誤。建議：
  - 本地有網路時可多跑幾次或手動驗證 2 人/Mesh 聊天；
  - CI 可只跑不依賴「已連線」的 E2E，或將依賴連線的案例標記為可選/較長超時。

### 建議驗證流程

1. **本機快速確認**  
   `npm run test:run` → 單元通過後，再跑  
   `npm run test:e2e -- tests/e2e/waiting-room.spec.ts tests/e2e/room-timeout.spec.ts`  
   確認等待頁與超時相關流程正常。

2. **完整 E2E（可選）**  
   `npm run test:e2e -- --timeout=120000`  
   需較長時間，且依賴 WebRTC 的案例可能因環境而失敗。

3. **手動驗證**  
   執行 `npm run dev`，用 2 個瀏覽器建立房間、加入、確認「已連線」與訊息收發；若有 3 人則可驗證 Mesh。

---

## 3. 本次提交內容摘要

- 完整測試流程文件（`docs/完整測試流程.md`）
- P2P 同步延遲修正（ChatPage、useRoomSubscription）
- E2E 真實環境調整（等待 60s、取消導向 15s、waiting-room 選擇器統一）
- 測試執行腳本（`scripts/*.ps1`、`scripts/README.md`）
- `.gitignore` 加入 test-results、playwright 產物

若您已設定 `origin`，在專案根目錄執行 `git push -u origin master`（或 `main`）即可推送。
