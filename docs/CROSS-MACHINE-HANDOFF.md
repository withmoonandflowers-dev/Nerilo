# 跨機器交接文件(Claude ↔ Claude via git)

> 目的:讓另一台電腦上的 Claude 只靠 `git clone` 就能接手分析與開發。
> 本文件是原機器 Claude 記憶的「可共享蒸餾版」,**不含任何金鑰或機密**。
> 最後更新:2026-07-03。行動前請先用 `git log` / `gh pr list` 驗證現況。

> 2026-07-16 起，會變動的完成度、測試基線與優先序統一維護在
> [CURRENT-STATUS.md](CURRENT-STATUS.md)。本檔其餘段落保留跨機器操作知識與歷史脈絡，
> 若快照與 CURRENT-STATUS 衝突，以後者為準。

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

**2026-07-03 更新（Mac 機器）:**
- 商業化分析入庫:docs/GOAL-ANALYSIS.md、docs/adr/(0001-0011)、docs/COMMERCIALIZATION-ROADMAP.md。
  定位已拍板(ADR-0009):Nerilo 是資料傳遞架構,聊天 app 是參考應用。
- **E2EE 已接電**(ADR-0004,commit 609b34e):星型路徑 SenderKeyManager 注入完成,
  fallback 改密文,徽章讀真值。行為變更:星型房 P2P 從未連上時 fallback 不再明文
  傳訊(訊息標失敗可重送);弱網補救(金鑰交換走 Firestore 信令)排 M4。
- 順修兩個既有 bug:fallback 缺 createdAt 遭 rules 拒寫;ECDH 公鑰互播無限迴圈隱患。
- **Production 煙霧測試上線**(`npm run smoke:prod`,tests/smoke/):對正式站跑
  S1 直連黃金路徑 / S2 強制 TURN(iceTransportPolicy=relay,等效雙嚴格 NAT)/
  S3 誠實降級,產出 smoke-artifacts/SMOKE-REPORT.md。首次已全綠:直連 RTT 87ms、
  **TURN relay→relay RTT 169ms(證實 TURN 憑證有效)**、訊息延遲約 180-190ms。
  取代了大部分「真機兩台互測」人工流程;仍需偶爾人工驗的只剩 iOS Safari、
  實體電信商 NAT、TURN 月額度耗盡。
  **關鍵測試語義**:ADR-0004 後「連線就緒 ≠ 可發送」,發訊前須等 E2EE 徽章
  離開 exchanging 進入已加密穩態(expectE2EESettled),否則會誤判。
- **待辦(P2,production console 有 CSP 噪音)**:blob worker 被 script-src 擋
  (`Creating a worker from 'blob:' violates CSP`)、Sentry envelope 上報被
  connect-src 擋(Sentry 實際上收不到事件!)、fresh 帳號讀 user data 一次
  permission-denied。三者皆不影響核心聊天,但 Sentry 那條使「已上線」的
  observability 假設不成立,值得優先修 CSP connect-src 加 sentry.io。

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

## 6b. 金流現況(2026-07-03)

- 供應商:Lemon Squeezy(MoR;Stripe 台灣不可用,查證見 ADR-0008 附錄)。
- Store:**Nerilo**(nerilo.lemonsqueezy.com),與同帳號另一 store(mNAV
  Dashboard,別的專案)互不相干。
- 商品:**Nerilo Pro**,NT$150/月訂閱,已 Published(**test mode**,
  store 尚未 activate,不能收真錢)。
- webhook 程式碼已入庫(netlify/functions/,commit 656ca3b),前端付費牆
  (usePlan + UpgradeButton)已接;test mode 結帳連結在 .env.local
  (VITE_LS_CHECKOUT_URL,production 需加 GitHub secret)。
- Netlify site **nerilo-webhook** 已建(site_id 880139cc-...,
  team withmoonandflowers),LS_WEBHOOK_SECRET 已設進站台環境變數。
- **webhook 已部署上線**:Netlify site **nerilo-api**(git 連 master 自動部署,
  workspace 帳號的 team,非 gmail 帳號的 Donekit team——注意 MCP 連 gmail
  帳號看不到此 site)。端點 https://nerilo-api.netlify.app/api/ls-webhook。
- **LS webhook 已設定**:URL 同上 + 5 事件(created/updated/resumed/expired/
  unpaused)。**簽章驗證 e2e 通過**(curl 正確簽章回 Ignored 200,錯誤簽章 401)。
  注意 **LS signing secret 上限 40 字元**,故用 32-char secret
  (兩邊一致設在 Netlify env LS_WEBHOOK_SECRET 與 LS webhook)。
- **舊 site nerilo-webhook(gmail Donekit team)已棄用**(額度用罄),真正在跑的是
  nerilo-api。gmail team 那顆 env 可忽略。
- 待辦(**使用者本人**,收真錢前才需要):(a) FIREBASE_SERVICE_ACCOUNT
  (Firebase Console → 服務帳戶 → 產生私鑰,壓單行)設進 nerilo-api 的 Netlify env
  ——沒有它 webhook 收到事件會在 setCustomUserClaims 前失敗(500),
  但簽章驗證與事件映射已可運作;(b) LS store activation(商業資料+身分+payout)。

## 6c. 系統可用狀態(2026-07-03 收尾)

**核心系統已完全可用**(production smoke test S1/S2/S3 全綠,build DHaqWeTx):
註冊/建房/加入/P2P 直連/TURN 中繼/E2EE 金鑰交換/雙向訊息/誠實降級皆通過。
三張安全與觀測任務卡全部完成並在 master:
- CSP 修復(c8f80b4):Sentry ingest + worker-src blob 放行,production console 已無錯誤(Sentry 收得到事件)。
- e2eTestMode 匿名建房漏洞:rules 已移除測試模式例外(純 sign_in_provider 檢查)。
- functions TS 編譯:已修,`cd functions && npx tsc -p tsconfig.json --noEmit` EXIT 0。

**付費閉環已完全打通(2026-07-04)。** FIREBASE_SERVICE_ACCOUNT 已由專案擁有者
(nerilo Firebase 綁在其 gmail 帳號,/u/2/)設進 Netlify nerilo-api 環境變數
(scope: Builds/Functions/Runtime,標記 secret)。雙重驗證:
  - 帶真實 uid 的簽章請求 → webhook 回 **200 OK**(getUser + setCustomUserClaims 成功)。
  - 帶不存在 uid → **400**(非先前的 500;證明 service account 初始化成功、
    code 到得了 getUser,只是查無此人)。
整條鏈路(升級按鈕帶 uid → LS checkout → 付款 → webhook 驗簽 → 事件映射 →
firebase-admin 寫 plan claim)實測全通。webhook secret 因 LS 上限用 32-char。
  - **注意**:Firebase 專案綁在**擁有者的 gmail 帳號**(非 workspace),
    未來要進 Firebase Console 需用對的帳號。service account 私鑰 Claude 不經手。

**Pro 實質權益現況**:每房人數已可伺服器端強制(Spec 011/ADR-0035,2026-07-18):
partial mesh 已接線(7-20 人檔,房間上限 10),firestore.rules 依 request.auth.token.plan
驗證建房容量(Free 5/Pro 10,maxParticipants 欄位、join 對文件強制)。Pro 建大房
入口目前只在 web-vue(React 凍結線建房仍缺省 5,join 大房不受影響)。fallback 配額
與 TURN 保障仍受 Functions 未部署限制,待 Blaze/Functions 後才誠實可做。
plan claim 讀取管道已就緒(usePlan hook,付款鏈路驗證時已確認徽章邏輯)。

**發放路徑補完(2026-07-18)**:(1) 手動發放 `scripts/grant-plan.mjs <uid|email> <pro|free>`
(需 service account,GOOGLE_APPLICATION_CREDENTIALS 或 FIREBASE_SERVICE_ACCOUNT;
供匯款成交/贈送/測試,與 webhook 同語義 merge claims)。(2) web-vue 建房 sheet 有
方案容量列+升級入口(PlanCapacityLine,composables/usePlan.ts;VITE_LS_CHECKOUT_URL
由 nuxt.config define 注入 process.env)。(3) 兩線升級點擊後 focus 強制刷新 token
(30 分鐘窗,轉 pro 即停)——LS 結帳在新分頁,claim 不會自己進本分頁的 ID token。
(4) rules 整合測試補 token.plan 容量五例(tests/integration/firestore-rules.spec.ts)。

**另一項使用者操作(資料保留,非阻塞)**:原生 TTL policy 需跑
`bash scripts/setup-ttl-policies.sh`(需 gcloud + GCP 權限),不跑僅過期資料不自動清。

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
