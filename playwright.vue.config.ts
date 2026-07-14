import { defineConfig, devices } from '@playwright/test';

/**
 * web-vue（Nuxt 重寫版）的 E2E 設定。
 * 跑法（與 React 版同一套 emulators）：
 *   firebase emulators:exec --only auth,firestore --project nerilo \
 *     "playwright test --config playwright.vue.config.ts"
 * VITE_USE_EMULATOR=true 讓 @legacy firebase config 走假 config + 本機 emulator
 * （nuxt dev 無法自訂 vite mode，故用顯式開關；見 src/config/firebase.ts）。
 */
export default defineConfig({
  testDir: 'tests/e2e-vue',
  timeout: 60_000,
  retries: 0,
  // 每個 spec 各開 2-3 個真實瀏覽器跑 WebRTC/ICE。預設 workers=cores/2 在多核機上會同時
  // 起十幾個瀏覽器，CPU 一被餓死，2 秒一次的 mesh anti-entropy 對帳與 DataChannel 送達
  // 就被拖慢，3 人 mesh-diagnostic 的 20s 送達界線偶發撞不到（實測 workers=6 → 6/8；
  // workers=2 → 6/6，17 個送達矩陣全乾淨）。故硬性限並行，讓測試在不被餓死的條件下量測，
  // 而非放寬送達界線來掩蓋。要在強機上加速可用 CLI --workers 覆寫（自負風險）。
  workers: 2,
  use: {
    baseURL: 'http://localhost:3210',
    trace: 'on-first-retry',
  },
  webServer: {
    // node 直呼 web-vue 本地 nuxt：repo 根的 npx 會抓最新版（4.4.5 dev server
    // 對 ssr:false 有 regression，版本釘死原因見 web-vue/nuxt.config.ts）
    command: 'node web-vue/node_modules/nuxt/bin/nuxt.mjs dev --cwd web-vue --port 3210',
    url: 'http://localhost:3210',
    reuseExistingServer: !process.env.CI,
    timeout: 180_000,
    stdout: 'ignore',
    stderr: 'pipe',
    env: {
      ...process.env,
      VITE_USE_EMULATOR: 'true',
    },
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
});
