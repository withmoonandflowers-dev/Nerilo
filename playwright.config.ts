import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: 'tests/e2e',
  timeout: 60_000,
  retries: 0,
  use: {
    baseURL: 'http://localhost:4173',
    trace: 'on-first-retry',
  },
  // 自動啟動開發伺服器
  webServer: {
    command: 'npm run dev:test',
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

