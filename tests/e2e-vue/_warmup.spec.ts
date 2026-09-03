/**
 * 路由預熱（非產品驗證，不進任何 stable 集）。
 *
 * 單 spec workflow（e2e-7p／e2e-e2ee）在乾淨 runner 上，nuxt dev server 首次編譯
 * 各路由可吃 >10s，會撞掉第一個產品斷言（實測兩次：createRoom 的
 * `toHaveURL(/waiting/)` 10s 窗）。vue-stable job 靠前面十幾條 spec 天然暖機，
 * 單 spec workflow 需顯式預熱。
 *
 * 刻意不做任何產品斷言——只把各路由編譯起來。用真 spec 當暖機會讓暖機本身
 * 成為冷啟動的受害者（e2ee run #3 實證：golden-path 當暖機時自己紅了）。
 */
import { test, expect } from '@playwright/test';

const ROUTES = ['/login', '/dashboard', '/waiting/warmup-nonexistent', '/chat/warmup-nonexistent'];

test.describe('路由預熱', () => {
  test('編譯各路由（無產品斷言） @vue-warmup', async ({ page }) => {
    test.setTimeout(180_000);
    for (const route of ROUTES) {
      // 首次編譯慢是預期；只等 DOM 掛上，不看內容、不斷言導轉結果
      await page.goto(route, { waitUntil: 'domcontentloaded', timeout: 60_000 }).catch(() => {});
      await expect(page.locator('body')).toBeVisible({ timeout: 60_000 });
    }
  });
});
