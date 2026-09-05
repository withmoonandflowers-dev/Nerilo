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
    // 僅供本機無法解析 mDNS .local（macOS Local Network 權限）時繞道，預設關閉；正解是修權限。
    // 啟用後 host candidate 會揭露真實 IP，改變實際 ICE candidate 型別，量測報告必須標註。
    // CI 不得設定 PW_DISABLE_MDNS，避免把繞道結果當成一般環境結果。
    launchOptions: process.env.PW_DISABLE_MDNS
      ? { args: ['--disable-features=WebRtcHideLocalIpsWithMdns'] }
      : {},
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
