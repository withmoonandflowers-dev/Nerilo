/**
 * Shared helpers for E2E tests.
 *
 * Every helper here uses Playwright's configured `baseURL` (4173 in test mode)
 * rather than hardcoded URLs. Helpers prefer Playwright's `expect(...).toPass`
 * and locator-based waits over `page.waitForTimeout(...)` so timing remains
 * physical (locator appears = ready) rather than guessed.
 */

import { expect, type Browser, type BrowserContext, type Page } from '@playwright/test';

export interface User {
  ctx: BrowserContext;
  page: Page;
}

/**
 * Spin up an isolated browser context and land on /dashboard with anonymous
 * auth completed (waits for the role badge to read 'guest' or 'user').
 */
export async function setupUser(browser: Browser): Promise<User> {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await page.goto('/dashboard');
  await expect(page.locator('.role-badge')).toBeVisible({ timeout: 15_000 });
  await expect(page.locator('.role-badge')).toContainText(/guest|user/, { timeout: 5_000 });
  return { ctx, page };
}

/** Tear down a user's context. Safe to call multiple times. */
export async function teardown(...users: User[]): Promise<void> {
  for (const u of users) {
    if (u?.ctx) {
      try {
        await u.ctx.close();
      } catch {
        /* ignore */
      }
    }
  }
}

/** Create a new room from the dashboard. Returns the roomId. */
export async function createRoom(page: Page): Promise<string> {
  await page.getByRole('button', { name: '+ 建立新房間' }).click();
  await page.getByRole('button', { name: '建立房間' }).click();
  await expect(page).toHaveURL(/\/waiting\/.+/, { timeout: 10_000 });
  const match = page.url().match(/\/waiting\/(.+)/);
  if (!match) throw new Error('Could not extract roomId from waiting URL');
  return match[1];
}

/** Navigate a user to /chat/{roomId}. The room must be open or have an empty slot. */
export async function joinRoom(page: Page, roomId: string): Promise<void> {
  await page.goto(`/chat/${roomId}`);
}

/**
 * Wait for the chat page to show '已連線' on the given pages. Uses a generous
 * timeout because WebRTC ICE gathering can legitimately take 30-60 s under
 * emulator conditions. Falls through if the Firestore fallback banner appears
 * instead — both are "ready to chat" states.
 */
export async function expectChatReady(page: Page, timeoutMs = 30_000): Promise<void> {
  await expect(page).toHaveURL(/\/chat\/.+/, { timeout: 15_000 });
  await Promise.race([
    expect(page.getByText('已連線')).toBeVisible({ timeout: timeoutMs }),
    expect(page.getByText('備援模式')).toBeVisible({ timeout: timeoutMs }),
  ]);
}

/** Send a chat message and wait for the input to clear (= dispatched). */
export async function sendMessage(page: Page, text: string): Promise<void> {
  const input = page.getByPlaceholder('輸入訊息...');
  await input.fill(text);
  await page.getByRole('button', { name: '傳送' }).click();
  await expect(input).toHaveValue('', { timeout: 5_000 });
}

/**
 * Wait until `message` is visible on `page`. Uses Playwright's auto-retrying
 * assertion so no fixed sleep is required.
 */
export async function expectMessageReceived(
  page: Page,
  message: string,
  timeoutMs = 10_000,
): Promise<void> {
  await expect(page.getByText(message).first()).toBeVisible({ timeout: timeoutMs });
}

/** Build a unique message body — keeps tests independent. */
export function uniqueMessage(prefix: string): string {
  return `${prefix} ${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
}
