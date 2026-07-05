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
