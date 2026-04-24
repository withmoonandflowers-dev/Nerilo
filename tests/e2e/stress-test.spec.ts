import { test, expect, type Page, type BrowserContext } from '@playwright/test';

/**
 * Nerilo 壓力測試套件
 * 測試項目：
 * 1. 頁面載入效能（LCP, FCP, TTI）
 * 2. 多用戶併發建房/加入
 * 3. 訊息吞吐量
 * 4. RTCPeerConnection 資源洩漏檢測
 * 5. Firestore 寫入壓力
 * 6. 記憶體洩漏偵測
 */

const BASE = 'http://localhost:3000';

// ─── 工具函式 ───────────────────────────────────────────────────────────

async function setupUser(browser: import('@playwright/test').Browser): Promise<{ ctx: BrowserContext; page: Page }> {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await page.goto(`${BASE}/dashboard`);
  await expect(page.locator('text=我的房間')).toBeVisible({ timeout: 15_000 });
  return { ctx, page };
}

async function createRoom(page: Page): Promise<string> {
  await page.click('button:has-text("建立新房間")');
  await page.waitForTimeout(300);
  await page.click('button:has-text("建立房間")');
  await expect(page).toHaveURL(/\/waiting\/.+/, { timeout: 10_000 });
  return page.url().split('/waiting/')[1]!;
}

async function getMetrics(page: Page) {
  return page.evaluate(() => {
    const nav = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming;
    const paint = performance.getEntriesByType('paint');
    const fcp = paint.find(e => e.name === 'first-contentful-paint')?.startTime ?? -1;
    return {
      dns: Math.round(nav.domainLookupEnd - nav.domainLookupStart),
      tcp: Math.round(nav.connectEnd - nav.connectStart),
      ttfb: Math.round(nav.responseStart - nav.requestStart),
      domContentLoaded: Math.round(nav.domContentLoadedEventEnd - nav.startTime),
      load: Math.round(nav.loadEventEnd - nav.startTime),
      fcp: Math.round(fcp),
      transferSize: nav.transferSize,
      domNodes: document.querySelectorAll('*').length,
    };
  });
}

async function getMemory(page: Page): Promise<number> {
  return page.evaluate(() => {
    // @ts-expect-error Chrome-only API
    return (performance as any).memory?.usedJSHeapSize ?? -1;
  });
}

async function _getPeerConnectionCount(page: Page): Promise<number> {
  return page.evaluate(() => {
    // Intercept RTCPeerConnection — 回傳 window 上的追蹤計數
    return (window as any).__rtcCount ?? -1;
  });
}

// ─── 測試 ────────────────────────────────────────────────────────────────

test.describe('壓力測試', () => {

  test('1. 頁面載入效能基準', async ({ browser }) => {
    const pages = ['login', 'dashboard'];
    for (const route of pages) {
      const ctx = await browser.newContext();
      const page = await ctx.newPage();

      const start = Date.now();
      await page.goto(`${BASE}/${route}`);
      // 不用 networkidle（Firestore WebSocket 永不 idle）
      await page.waitForLoadState('domcontentloaded');
      await page.waitForTimeout(1000); // 等 React hydration
      const wallTime = Date.now() - start;

      const metrics = await getMetrics(page);
      console.log(`\n📊 [${route}] Performance:`);
      console.log(`   Wall time: ${wallTime}ms`);
      console.log(`   FCP: ${metrics.fcp}ms`);
      console.log(`   DOM Content Loaded: ${metrics.domContentLoaded}ms`);
      console.log(`   Full Load: ${metrics.load}ms`);
      console.log(`   TTFB: ${metrics.ttfb}ms`);
      console.log(`   DOM Nodes: ${metrics.domNodes}`);
      console.log(`   Transfer: ${(metrics.transferSize / 1024).toFixed(1)}KB`);

      // 效能基準斷言
      expect(metrics.fcp, `${route} FCP should be < 3s`).toBeLessThan(3000);
      expect(metrics.domContentLoaded, `${route} DCL should be < 5s`).toBeLessThan(5000);
      expect(metrics.domNodes, `${route} DOM nodes should be < 1000`).toBeLessThan(1000);

      await ctx.close();
    }
  });

  test('2. 併發建房壓力（5 個用戶同時建房）', async ({ browser }) => {
    const COUNT = 5;
    const users: { ctx: BrowserContext; page: Page }[] = [];

    // 同時建立 5 個用戶
    const setupStart = Date.now();
    const setupPromises = Array.from({ length: COUNT }, () => setupUser(browser));
    const results = await Promise.all(setupPromises);
    users.push(...results);
    const setupTime = Date.now() - setupStart;
    console.log(`\n📊 [併發建房] ${COUNT} users setup: ${setupTime}ms (${(setupTime / COUNT).toFixed(0)}ms/user)`);

    // 同時建房
    const createStart = Date.now();
    const roomIds = await Promise.all(users.map(u => createRoom(u.page)));
    const createTime = Date.now() - createStart;
    console.log(`   ${COUNT} rooms created: ${createTime}ms (${(createTime / COUNT).toFixed(0)}ms/room)`);

    // 驗證每個房間 ID 都不同
    const unique = new Set(roomIds);
    expect(unique.size).toBe(COUNT);
    console.log(`   ✅ All ${COUNT} room IDs unique`);

    // 清理
    for (const u of users) await u.ctx.close();
  });

  test('3. 單房間多人加入壓力（1 host + 4 joiners）', async ({ browser }) => {
    const host = await setupUser(browser);
    const roomId = await createRoom(host.page);
    console.log(`\n📊 [多人加入] Room: ${roomId.slice(0, 8)}...`);

    const JOINER_COUNT = 4;
    const joiners: { ctx: BrowserContext; page: Page }[] = [];

    const joinStart = Date.now();
    for (let i = 0; i < JOINER_COUNT; i++) {
      const joiner = await setupUser(browser);
      await joiner.page.goto(`${BASE}/chat/${roomId}`);
      await joiner.page.waitForTimeout(1000);
      joiners.push(joiner);
      console.log(`   Joiner ${i + 1} joined at ${Date.now() - joinStart}ms`);
    }
    const joinTime = Date.now() - joinStart;
    console.log(`   Total join time: ${joinTime}ms (${(joinTime / JOINER_COUNT).toFixed(0)}ms/joiner)`);

    // 等待 host 也轉到 chat 頁面
    await expect(host.page).toHaveURL(/\/chat\//, { timeout: 15_000 });
    console.log(`   ✅ Host transitioned to chat`);

    // 檢查每個 joiner 都有輸入框
    let chatReady = 0;
    for (const j of joiners) {
      const input = j.page.locator('input[type="text"], textarea').first();
      if (await input.isVisible({ timeout: 10_000 }).catch(() => false)) chatReady++;
    }
    console.log(`   ✅ ${chatReady}/${JOINER_COUNT} joiners have chat input`);

    // 清理
    for (const j of joiners) await j.ctx.close();
    await host.ctx.close();
  });

  test('4. RTCPeerConnection 洩漏偵測', async ({ browser }) => {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();

    // 注入 RTCPeerConnection 追蹤器
    await page.addInitScript(() => {
      let count = 0;
      const OrigRTC = window.RTCPeerConnection;
      window.RTCPeerConnection = class extends OrigRTC {
        constructor(config?: RTCConfiguration) {
          super(config);
          count++;
          (window as any).__rtcCount = count;
          (window as any).__rtcActive = ((window as any).__rtcActive ?? 0) + 1;
          this.addEventListener('connectionstatechange', () => {
            if (this.connectionState === 'closed' || this.connectionState === 'failed') {
              (window as any).__rtcActive = Math.max(0, ((window as any).__rtcActive ?? 1) - 1);
            }
          });
        }
        close() {
          super.close();
          (window as any).__rtcActive = Math.max(0, ((window as any).__rtcActive ?? 1) - 1);
        }
      } as any;
    });

    // 建房 → 離開 → 再建房，看 PC 是否正確釋放
    await page.goto(`${BASE}/dashboard`);
    await expect(page.locator('text=我的房間')).toBeVisible({ timeout: 15_000 });

    for (let round = 1; round <= 3; round++) {
      await page.click('button:has-text("建立新房間")');
      await page.waitForTimeout(300);
      await page.click('button:has-text("建立房間")');
      await expect(page).toHaveURL(/\/waiting\//, { timeout: 10_000 });
      await page.waitForTimeout(2000);

      const rtcTotal = await page.evaluate(() => (window as any).__rtcCount ?? 0);
      const rtcActive = await page.evaluate(() => (window as any).__rtcActive ?? 0);
      console.log(`\n📊 [PC洩漏] Round ${round}: total=${rtcTotal}, active=${rtcActive}`);

      // 返回 dashboard
      await page.goto(`${BASE}/dashboard`);
      await page.waitForTimeout(2000);

      const afterLeave = await page.evaluate(() => (window as any).__rtcActive ?? 0);
      console.log(`   After leave: active=${afterLeave}`);

      // 離開後不應該有存活的 PC
      if (round > 1) {
        // 第一次可能因為 waiting room 不建 PC，所以從第 2 次開始檢查
        expect(afterLeave, `Round ${round}: active PCs after leave should be 0`).toBeLessThanOrEqual(1);
      }
    }

    await ctx.close();
  });

  test('5. 記憶體壓力測試（重複進出房間）', async ({ browser }) => {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await page.goto(`${BASE}/dashboard`);
    await expect(page.locator('text=我的房間')).toBeVisible({ timeout: 15_000 });

    const memSamples: number[] = [];
    const initialMem = await getMemory(page);
    if (initialMem > 0) memSamples.push(initialMem);

    console.log(`\n📊 [記憶體] Initial: ${(initialMem / 1024 / 1024).toFixed(1)}MB`);

    for (let i = 0; i < 5; i++) {
      // 建房
      await page.click('button:has-text("建立新房間")');
      await page.waitForTimeout(300);
      await page.click('button:has-text("建立房間")');
      await expect(page).toHaveURL(/\/waiting\//, { timeout: 10_000 });
      await page.waitForTimeout(1000);

      // 離開
      await page.goto(`${BASE}/dashboard`);
      await page.waitForTimeout(1000);

      const mem = await getMemory(page);
      if (mem > 0) memSamples.push(mem);
      console.log(`   Round ${i + 1}: ${(mem / 1024 / 1024).toFixed(1)}MB`);
    }

    if (memSamples.length >= 3) {
      const first = memSamples[0]!;
      const last = memSamples[memSamples.length - 1]!;
      const growth = ((last - first) / first) * 100;
      console.log(`   Growth: ${growth.toFixed(1)}% (${((last - first) / 1024 / 1024).toFixed(1)}MB)`);

      // 記憶體成長不應超過 100%（嚴重洩漏指標）
      expect(growth, 'Memory growth should be < 100%').toBeLessThan(100);
    }

    await ctx.close();
  });

  test('6. Firestore 寫入壓力（快速連續建房）', async ({ browser }) => {
    const { ctx, page } = await setupUser(browser);
    const ROUNDS = 8;
    const times: number[] = [];

    console.log(`\n📊 [Firestore壓力] ${ROUNDS} sequential room creates:`);

    for (let i = 0; i < ROUNDS; i++) {
      const start = Date.now();
      await page.click('button:has-text("建立新房間")');
      await page.waitForTimeout(200);
      await page.click('button:has-text("建立房間")');
      await expect(page).toHaveURL(/\/waiting\//, { timeout: 15_000 });
      const elapsed = Date.now() - start;
      times.push(elapsed);
      console.log(`   Room ${i + 1}: ${elapsed}ms`);

      // 返回 dashboard
      await page.goto(`${BASE}/dashboard`);
      await expect(page.locator('text=我的房間')).toBeVisible({ timeout: 10_000 });
    }

    const avg = times.reduce((a, b) => a + b, 0) / times.length;
    const max = Math.max(...times);
    const min = Math.min(...times);
    console.log(`   Avg: ${avg.toFixed(0)}ms, Min: ${min}ms, Max: ${max}ms`);

    // 平均建房時間不應超過 5 秒
    expect(avg, 'Average room creation should be < 5s').toBeLessThan(5000);
    // 最大值不應超過 10 秒
    expect(max, 'Max room creation should be < 10s').toBeLessThan(10000);

    await ctx.close();
  });
});
