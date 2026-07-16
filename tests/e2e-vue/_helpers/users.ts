/**
 * web-vue E2E 共用 helpers（selectors 對齊 Vue 頁面；語義對齊 React 版 helpers）。
 */
import { expect, type Browser, type BrowserContext, type Page } from '@playwright/test';

export interface User {
  ctx: BrowserContext;
  page: Page;
}

const TEST_PASSWORD = 'Test123456';
const uniqueEmail = () =>
  `e2e-vue-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@nerilo-e2e.test`;

let userSeq = 0;

/** 註冊一個新帳號並落地 dashboard */
export async function setupUser(browser: Browser): Promise<User> {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  // 失敗診斷證據：featureLog 與 error/warning 轉錄到測試輸出
  const tag = `U${++userSeq}`;
  page.on('console', (msg) => {
    const text = msg.text();
    if (
      msg.type() === 'error' ||
      msg.type() === 'warning' ||
      text.includes('NERILO') ||
      /GossipMessageHandler|MeshGossipManager|MeshTopologyManager|MeshConnection/.test(text)
    ) {
      console.log(`[${tag}]`, msg.type(), text);
    }
  });
  await page.goto('/login');
  // 保險絲：test mode 會在 window 掛 __nerilo_test__；不存在代表 app 沒連
  // emulator（正打向正式 Firebase）——立即失敗，不准把測試資料寫進 prod。
  await expect
    .poll(
      () =>
        page.evaluate(
          () => !!(window as unknown as { __nerilo_test__?: unknown }).__nerilo_test__
        ),
      { timeout: 15_000 }
    )
    .toBe(true);
  await page.getByRole('button', { name: '使用 Email 登入' }).click();
  await page.getByRole('button', { name: '沒有帳號？註冊' }).click();
  await page.getByPlaceholder('Email').fill(uniqueEmail());
  await page.getByPlaceholder('密碼').fill(TEST_PASSWORD);
  await page.getByRole('button', { name: '註冊' }).click();
  await expect(page).toHaveURL(/\/dashboard/, { timeout: 15_000 });
  return { ctx, page };
}

export async function teardown(...users: User[]): Promise<void> {
  for (const u of users) {
    try {
      await u?.ctx.close();
    } catch {
      /* ignore */
    }
  }
}

/** 建房 → 落地 /waiting/{roomId}，回傳 roomId */
export async function createRoom(page: Page): Promise<string> {
  await page.getByRole('button', { name: '建立或加入房間' }).click();
  // sheet 內 tab 與 submit 同文字「建立房間」，鎖定表單 submit
  await page.locator('.sheet__form button[type="submit"]').click();
  await expect(page).toHaveURL(/\/waiting\/.+/, { timeout: 10_000 });
  const match = page.url().match(/\/waiting\/([^/?#]+)/);
  if (!match) throw new Error('Could not extract roomId from waiting URL');
  return match[1]!;
}

export async function joinRoom(page: Page, roomId: string): Promise<void> {
  await page.goto(`/chat/${roomId}`);
}

/**
 * 等聊天就緒（P2P 已連線）。WebRTC/ICE 在模擬器下合法地慢（30-60s），
 * timeout 涵蓋連線成形；訊息送達的斷言仍各自維持緊 timeout。
 */
export async function expectChatReady(page: Page, timeoutMs = 60_000): Promise<void> {
  await expect(page).toHaveURL(/\/chat\/.+/, { timeout: 20_000 });
  await expect(page.locator('.chat__status')).toHaveText(/已連線/, { timeout: timeoutMs });
}

export async function sendMessage(page: Page, text: string): Promise<void> {
  const input = page.getByLabel('訊息輸入框');
  await input.fill(text);
  await page.getByRole('button', { name: '傳送', exact: true }).click();
  await expect(input).toHaveValue('', { timeout: 5_000 });
}

export function uniqueMessage(prefix: string): string {
  return `${prefix} ${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
}

/** 訊息在畫面上恰好一次（count==1 同時抓漏與重） */
export async function expectExactlyOnce(page: Page, text: string, timeoutMs = 15_000): Promise<void> {
  await expect(page.locator('.bubble').filter({ hasText: text }).first()).toBeVisible({
    timeout: timeoutMs,
  });
  await expect(page.locator('.bubble').filter({ hasText: text })).toHaveCount(1);
}
