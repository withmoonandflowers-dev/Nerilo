#!/usr/bin/env node
/**
 * Spec 023 V3：延遲量測 runner。
 * 起一個關閉背景/遮蔽節流的 Chromium 跑 examples/transport-latency 頁，
 * 等 #verdict 出現後把整頁結果印出來，PASS 才 exit 0。
 * 前置：dev server 已在 5181（npm run example:latency）。
 */
import { chromium } from '@playwright/test';

const URL = process.env.LAT_URL ?? 'http://localhost:5181';

const browser = await chromium.launch({
  args: [
    '--disable-background-timer-throttling',
    '--disable-renderer-backgrounding',
    '--disable-backgrounding-occluded-windows',
  ],
});
try {
  const page = await browser.newPage();
  await page.goto(URL);
  await page.waitForSelector('#verdict', { timeout: 60_000 });
  const text = await page.locator('#out').innerText();
  const verdict = await page.locator('#verdict').innerText();
  console.log(text);
  console.log('---');
  console.log(verdict);
  process.exitCode = verdict.includes('PASS') ? 0 : 1;
} finally {
  await browser.close();
}
