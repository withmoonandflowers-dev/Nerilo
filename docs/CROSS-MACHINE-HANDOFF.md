# 跨機器交接文件(Claude ↔ Claude via git)

> 目的:讓另一台電腦上的 Claude 只靠 `git clone` 就能接手分析與開發。
> 本文件是原機器 Claude 記憶的「可共享蒸餾版」,**不含任何金鑰或機密**。
> 最後更新:2026-07-03。行動前請先用 `git log` / `gh pr list` 驗證現況。

## 1. 環境設定(新機器第一次)

```powershell
npm ci                      # 安裝依賴(firebase-tools 已是 devDependency,不需全域安裝)
node ./node_modules/typescript/bin/tsc --noEmit   # 驗證環境
```

### Windows 重大陷阱:npm shim

在**非互動 shell**(Claude 的 Bash/PowerShell 工具、排程任務)中,`npm run <script>` 會經過
cmd.exe shim 而遺失 PATH 中的 `node`,出現亂碼錯誤 `'node' 不是內部或外部命令`。
**一律直接用 node 呼叫 bin 路徑**:

```powershell
node ./node_modules/typescript/bin/tsc --noEmit        # 不要 npm run type-check
node ./node_modules/vitest/vitest.mjs run              # 不要 npm run test:run
node ./node_modules/eslint/bin/eslint.js . --ext ts,tsx  # 不要 npm run lint
```

純 npm 操作(`npm ci`、`npm audit`)不受影響。使用者本人在互動終端用 `npm run` 沒問題。

## 2. E2E 本地執行(模擬器,非 live Firebase)

E2E 透過 `src/config/firebase.ts` 的 `IS_TEST_MODE` 硬接到模擬器(Auth 9099 / Firestore 8080)。

兩個必要條件:
1. **JDK 21**(firebase-tools 15 對所有模擬器強制要求 Java ≥ 21)。原機器用 Adoptium 免安裝版;新機器請自行下載解壓,把 `JAVA_HOME` + `PATH` 指過去。
2. **必須用 PowerShell,不能用 Git Bash**(子程序是 cmd.exe,吃不了 Git Bash 的 POSIX PATH)。

可用的呼叫(PowerShell):

```powershell
$env:JAVA_HOME = "<JDK21路徑>"
$env:PATH = "<JDK21路徑>\bin;" + $env:PATH
node ".\node_modules\firebase-tools\lib\bin\firebase.js" emulators:exec --only auth,firestore --project nerilo "node ./node_modules/@playwright/test/cli.js test --grep @stable --reporter=list"
```

- `@stable` 子集(auth-flow + golden-path,10 tests)約 20 秒,是 deploy-gating 的那組,目前 master 全綠。
- 加 `--trace on` 可拿到失敗當下的 accessibility snapshot + trace.zip。
- **已知債務(P1,不擋 deploy):** 完整 E2E 套件 16 過 / 54 敗,全是非 gating 舊 spec 的陳年腐壞
  (寫死 `localhost:3000`、`page.evaluate` 裡 bare import、重複的 modal selector)。值得一次清理。

## 3. CI / 部署 / Secrets 佈局

- `ci.yml`:push/PR → type-check + lint(上限 10 warnings)+ 單元測試(Node 24)+ 模擬器 E2E(軟性)。
- `firebase-deploy.yml`:**push master 即自動部署** hosting + Firestore rules → https://nerilo.web.app。Functions 不部署(需 Blaze 方案,步驟見 PR #15)。
- GitHub secrets(只列名稱):`FIREBASE_SERVICE_ACCOUNT_NERILO`、`VITE_FIREBASE_*` ×6、`VITE_SENTRY_DSN`、`VITE_TURN_{URLS,USERNAME,CREDENTIAL}`、`ANTHROPIC_API_KEY`(**此 key 值目前無效**,claude-pr-review 因此不動作,需使用者重設)。
- 部署分流見 `docs/DEPLOYMENT.md`:staging 用 Hosting preview channel(`npm run deploy:staging`),production 用 `deploy:production:safe`。
- **GitHub Actions 免費額度**:私有 repo 每月 2000 分鐘,用完後 push **靜默地**不觸發任何 run、`workflow_dispatch` 回 HTTP 500。看到「零 check、無錯誤訊息」先懷疑額度(帳單頁確認),不是 workflow 壞掉。
- `claude-code-action@v1` 兩個坑:permissions 必須含 `id-token: write`(官方文件漏了);workflow 檔必須先以相同內容存在於 default branch 才會執行(bootstrap PR 本身不會被 review)。

## 4. TURN(NAT 穿透)

- 供應商 Metered.ca(dashboard:nerilo.metered.live,app "nerilo",試用方案 500MB/月;用完自動退回 Firestore relay,不會壞)。
- 接線:`src/core/p2p/IceServerProvider.ts` 讀 `VITE_TURN_*`,由 deploy workflow 從 secrets 注入;未設定則安全退回 STUN-only。
- **輪替憑證流程**(帳號 SECRET KEY 在 Metered Developers 頁,**絕不入庫**):
  1. `POST https://nerilo.metered.live/api/v1/turn/credential?secretKey=<帳號secret>`,body `{"label":"...","expiryInSeconds":0}` → 回 per-credential apiKey
  2. `GET https://nerilo.metered.live/api/v1/turn/credentials?apiKey=<上一步的apiKey>` → 完整 iceServers
  3. `gh secret set VITE_TURN_{URLS,USERNAME,CREDENTIAL}` + `gh workflow run firebase-deploy.yml --ref master`
  - 注意:舊版 `GET ...?apiKey=<帳號secret>` 會回 "Invalid API Key",別走那條(曾浪費大量除錯時間)。

## 5. Auth 診斷教訓(已解決,但原理要記住)

- **production-only 的 `auth/internal-error` + localhost/REST 都正常 → 先查 CSP**(`firebase.json` 的 header 只在 Hosting 上生效)。Google auth 需要 script-src 含 `apis.google.com`、`www.gstatic.com`、`www.google.com`,frame-src 含 `accounts.google.com`、`www.google.com`(PR #31 已修)。
- **不要把 authDomain 改離 `<project>.firebaseapp.com`**,除非同步在 Google Cloud Console 的 OAuth client 加上新網域的 `/__/auth/handler` redirect URI(曾因此造成 `redirect_uri_mismatch`)。
- 免憑證快速診斷法:直接打 Firebase Auth REST API(`identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=<web API key>`,key 可從 `https://nerilo.web.app/__/firebase/init.json` 取得)→ 看到 SDK `internal-error` 背後的真實錯誤碼。

## 6. 待辦快照(2026-07-03,行動前請驗證)

**等使用者(Claude 無法代做):**
- 真機煙霧測試:兩台裝置(一台走行動網路)完整走一遍建房→邀請→加入→互傳。行動網路加入那步是 TURN 的真實驗證。
- 軟啟動邀請朋友 → 產生 onboarding funnel 數據(`featureLog` category `onboarding` 已埋點)來決定下一輪方向。
- Sentry 已上線,建議觸發一次錯誤確認 dashboard 收得到事件。

**技術待辦:**
- P1:非 gating E2E 腐壞清理(54 個失敗,見上)。
- P2:typing indicator 只支援 2 人星型,mesh(3+)未支援。
- 待決策(需使用者拍板,勿自動實作):guest 直接建房(需開放 Firestore 匿名寫入,是安全模型決定)。

**分支現況:**
- `prompts/`(13 個 review 角色 prompt + REVIEW-PIPELINE.md)只在 `feature/multi-room-improvements` 分支,尚未進 master。
- `worktree-agent-*` 與 `claude/*` 分支皆無領先 master 的 commit,可忽略。

## 7. 刻意的設計決定(不要翻案)

- `reports/` gitignored;健康檢查排程只監控不修改。
- lint 上限 `--max-warnings 10`;測試檔豁免 no-explicit-any;未用參數以 `_` 前綴。
- 用 `roomDisplayName()`(src/utils)取房名 fallback,勿重複硬編碼。
- Onboarding modal 在 localStorage 被擋(無痕模式)時要能優雅降級 — 維持此行為。

## 8. 跨機器協作約定

- 只透過 git 溝通:交接狀態寫進本文件(或 PR 描述),commit 後 push。
- `.claude/commands/` 與 `.claude/skills/` 已入庫 — 兩台機器共用同一套 UX skill 與工作流 prompt;修改後記得 commit。
- `.claude/settings.local.json`、`.claude/worktrees/` 維持 gitignore(機器本地狀態)。
- 每台機器的 Claude 各有自己的本地記憶;**跨機器要共享的知識請更新本文件**,不要只存在記憶裡。
