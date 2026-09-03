import { defineConfig, devices } from '@playwright/test';

const rawBaseUrl = process.env.VUE_SMOKE_BASE_URL;

if (!rawBaseUrl) {
  throw new Error(
    'VUE_SMOKE_BASE_URL is required. Point it at the isolated Vue preview channel, never production.'
  );
}

const baseUrl = new URL(rawBaseUrl);
const forbiddenHosts = new Set(['nerilo.web.app', 'nerilo.firebaseapp.com']);

if (baseUrl.protocol !== 'https:' || forbiddenHosts.has(baseUrl.hostname)) {
  throw new Error(
    `Refusing Vue smoke target ${baseUrl.origin}; use an HTTPS nerilo-staging preview URL.`
  );
}

if (!baseUrl.hostname.startsWith('nerilo-staging--')) {
  throw new Error(
    `Refusing Vue smoke target ${baseUrl.origin}; hostname must be a nerilo-staging preview channel.`
  );
}

export default defineConfig({
  testDir: './tests/smoke-vue',
  timeout: 180_000,
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [
    ['list'],
    ['json', { outputFile: 'smoke-artifacts/vue-results.json' }],
  ],
  use: {
    baseURL: baseUrl.origin,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
});
