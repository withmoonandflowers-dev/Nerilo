import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: 'tests/e2e',
  timeout: 60_000,
  retries: 0,
  // 兩套 config 可由人工指定隔離目錄，避免互相清 artifact；不預設並行，避免餓死 Vue workers=2 並汙染 C2 毫秒量測。
  outputDir: process.env.PW_OUTPUT_DIR ?? 'test-results',
  // reporter 在此宣告一次，npm script 與 CLI 不要再用 --reporter 覆寫，
  // 否則 html 不會產生、CI 的「上傳報告」步驟空跑（見 playwright.vue.config.ts）。
  reporter: [['list'], ['html', { open: 'never', outputFolder: process.env.PW_REPORT_DIR ?? 'playwright-report' }]],
  use: {
    baseURL: 'http://localhost:4173',
    // 僅供本機無法解析 mDNS .local（macOS Local Network 權限）時繞道，預設關閉；正解是修權限。
    // 啟用後 host candidate 會揭露真實 IP，改變實際 ICE candidate 型別，量測報告必須標註。
    // CI 不得設定 PW_DISABLE_MDNS，避免把繞道結果當成一般環境結果。
    launchOptions: process.env.PW_DISABLE_MDNS
      ? { args: ['--disable-features=WebRtcHideLocalIpsWithMdns'] }
      : {},
    // 同 playwright.vue.config.ts：retries=0 讓 'on-first-retry' 永遠觸發不到，
    // e2e-tests.yml 的 test-results/ 失敗上傳因此一直是空的。
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  // 自動啟動開發伺服器
  // Use node-direct invocation so this works on Windows (where Node subprocesses
  // can't always resolve the npm shim) AND on Linux CI. See memory note:
  // windows_node_invocation.md
  webServer: {
    command: 'node ./node_modules/vite/bin/vite.js --port 4173 --strictPort --mode test',
    url: 'http://localhost:4173',
    reuseExistingServer: !process.env.CI, // CI 環境中不重用現有伺服器
    timeout: 120_000, // 給伺服器更多時間啟動
    stdout: 'ignore',
    stderr: 'pipe',
    env: {
      ...process.env,
      VITE_ALLOW_GUEST_CREATE_ROOM: 'true', // 測試環境允許 guest 建立房間
    },
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
});
