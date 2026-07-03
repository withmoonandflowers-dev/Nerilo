/**
 * Production 煙霧測試設定。
 *
 * 與 playwright.config.ts（模擬器 E2E）分離：這份直接打正式站
 * （或 SMOKE_BASE_URL 指定的環境），不啟動本地 server、不用模擬器。
 *
 * 執行：npm run smoke:prod
 * 報告：smoke-artifacts/SMOKE-REPORT.md（scripts/smoke-report.mjs 產出）
 */
import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests/smoke',
  timeout: 120_000,
  fullyParallel: false, // 三個場景共用兩個測試帳號，序列執行避免互踩
  workers: 1,
  retries: 0,
  reporter: [
    ['list'],
    ['json', { outputFile: 'smoke-artifacts/results.json' }],
  ],
  use: {
    baseURL: process.env.SMOKE_BASE_URL ?? 'https://nerilo.web.app',
    trace: 'retain-on-failure',
  },
});
