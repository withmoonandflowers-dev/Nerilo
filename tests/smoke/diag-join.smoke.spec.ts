/**
 * 診斷用（不進 CI）：S1 卡在 /waiting→/chat 的根因定位。
 * 蒐集 alice/bob 兩端 console（prod build 的 logger.error/warn 仍輸出）、URL 演變、
 * bob 端 toast。跑完印報告，不做嚴格斷言（診斷優先於紅綠）。
 */
import { test, type Browser, type Page, expect } from '@playwright/test';
import { createRoom, dismissWelcomeModal } from '../e2e/_helpers/users';

const PASSWORD = 'Test123456';
const uniqueEmail = (tag: string) =>
  `diag-${tag}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@nerilo-e2e.test`;

interface DiagUser {
  page: Page;
  logs: string[];
}

async function setupDiagUser(browser: Browser, tag: string): Promise<DiagUser> {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  const logs: string[] = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error' || msg.type() === 'warning') {
      logs.push(`[${tag}][${msg.type()}] ${msg.text().slice(0, 300)}`);
    }
  });
  page.on('pageerror', (err) => logs.push(`[${tag}][pageerror] ${String(err).slice(0, 300)}`));
  await page.goto('/login');
  await page.locator('.auth-toggle-link').click();
  await expect(page.locator('.login-form button[type="submit"]')).toHaveText('註冊');
  await page.fill('#email', uniqueEmail(tag));
  await page.fill('#password', PASSWORD);
  await page.locator('.login-form button[type="submit"]').click();
  await expect(page).toHaveURL(/\/dashboard/, { timeout: 20_000 });
  await expect(page.locator('.role-badge')).toContainText('user', { timeout: 10_000 });
  await dismissWelcomeModal(page);
  return { page, logs };
}

test('diag: bob join 之後兩端到底發生什麼', async ({ browser }) => {
  test.skip(!process.env.DIAG, '診斷用：DIAG=1 才跑，不進例行 smoke（會多燒配額）');
  test.setTimeout(150_000);
  const alice = await setupDiagUser(browser, 'alice');
  const bob = await setupDiagUser(browser, 'bob');

  const roomId = await createRoom(alice.page);
  console.log(`\n=== roomId: ${roomId} ===`);
  console.log(`alice url after create: ${alice.page.url()}`);

  // bob 加入（React 流程：goto /chat/{id} → ChatPage useEffect 跑 joinRoom）
  await bob.page.goto(`/chat/${roomId}`);

  // 觀察 40 秒：每 5 秒記錄兩端 URL 與 bob 頁面上的狀態文字
  for (let i = 1; i <= 8; i++) {
    await bob.page.waitForTimeout(5_000);
    const bobBanner = await bob.page
      .locator('.connection-banner-text')
      .textContent()
      .catch(() => '(無 banner)');
    const bobToast = await bob.page
      .locator('.toast, [class*="toast"]')
      .allTextContents()
      .catch(() => [] as string[]);
    console.log(
      `t+${i * 5}s  alice=${alice.page.url().replace(/^https?:\/\/[^/]+/, '')}  ` +
      `bob=${bob.page.url().replace(/^https?:\/\/[^/]+/, '')}  ` +
      `bobBanner=${JSON.stringify(bobBanner)}  bobToast=${JSON.stringify(bobToast)}`
    );
    if (/\/chat\//.test(alice.page.url())) break; // alice 轉場成功即收工
  }

  console.log('\n=== alice console (error/warn) ===');
  alice.logs.forEach((l) => console.log(l));
  console.log('\n=== bob console (error/warn) ===');
  bob.logs.forEach((l) => console.log(l));
});
