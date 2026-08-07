import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: 'tests/e2e',
  timeout: 60_000,
  retries: 0,
  // reporter 在此宣告一次，npm script 與 CLI 不要再用 --reporter 覆寫，
  // 否則 html 不會產生、CI 的「上傳報告」步驟空跑（見 playwright.vue.config.ts）。
  reporter: [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL: 'http://localhost:4173',
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

