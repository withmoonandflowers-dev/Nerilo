import { defineConfig, devices } from '@playwright/test';

/** Spec 027 內建聊天頁：以真 HTTP 會合點與兩個隔離瀏覽器驗證本機 WebRTC/E2EE。 */
export default defineConfig({
  testDir: './tests/e2e-rendezvous',
  timeout: 90_000,
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: 'list',
  use: {
    baseURL: 'http://localhost:9973',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  webServer: {
    command: 'node tools/rendezvous-server.mjs 9973',
    url: 'http://localhost:9973',
    reuseExistingServer: false,
    timeout: 30_000,
    stdout: 'ignore',
    stderr: 'pipe',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
});
