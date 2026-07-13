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
 * Dismiss the first-run WelcomeModal if it is showing.
 *
 * A fresh browser context has no `nerilo_onboarded` localStorage flag, so a
 * newly-landed user gets the onboarding modal. Its overlay is `aria-modal` and
 * intercepts pointer events, so anything behind it on the dashboard (create
 * room, logout, …) is un-clickable until the modal is closed. Clicking
 * "之後再說" closes it and sets the flag, so it won't reappear in the same
 * context. Tolerant: a no-op if the modal isn't present.
 */
export async function dismissWelcomeModal(page: Page): Promise<void> {
  const dismiss = page.locator('.welcome-btn-dismiss');
  try {
    await dismiss.waitFor({ state: 'visible', timeout: 5_000 });
  } catch {
    return; // modal not shown (flag already set, or feature disabled)
  }
  await dismiss.click();
  await expect(page.locator('.welcome-modal-overlay')).toHaveCount(0);
}

const TEST_PASSWORD = 'Test123456';
const uniqueEmail = () =>
  `e2e-user-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@nerilo-e2e.test`;

/**
 * Spin up an isolated browser context, register a throwaway email/password
 * account against the Firebase Auth emulator, and land on /dashboard as a
 * non-anonymous 'user'. Firestore rules require a non-anonymous account to
 * create rooms, so this is the default setup for any test that creates one.
 * Dismisses the first-run onboarding modal so the dashboard is interactable.
 */
export async function setupUser(browser: Browser): Promise<User> {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await page.goto('/login');
  // Switch the login form into register mode, then submit a unique account.
  await page.locator('.auth-toggle-link').click();
  await expect(page.locator('.login-form button[type="submit"]')).toHaveText('註冊');
  await page.fill('#email', uniqueEmail());
  await page.fill('#password', TEST_PASSWORD);
  await page.locator('.login-form button[type="submit"]').click();
  await expect(page).toHaveURL(/\/dashboard/, { timeout: 15_000 });
  await expect(page.locator('.role-badge')).toContainText('user', { timeout: 5_000 });
  await dismissWelcomeModal(page);
  return { ctx, page };
}

/**
 * Spin up an isolated browser context and land on /dashboard with anonymous
 * auth (role 'guest'). Anonymous users can join rooms but cannot create them —
 * use this only for tests that specifically exercise the guest path.
 */
export async function setupAnonUser(browser: Browser): Promise<User> {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await page.goto('/dashboard');
  await expect(page.locator('.role-badge')).toBeVisible({ timeout: 15_000 });
  await expect(page.locator('.role-badge')).toContainText(/guest|user/, { timeout: 5_000 });
  await dismissWelcomeModal(page);
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
  // exact: the open form's confirm button is "建立房間", but the header toggle's
  // aria-label becomes "取消建立房間" (a superstring) — a non-exact match hits both.
  await page.getByRole('button', { name: '建立房間', exact: true }).click();
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
 * Wait for the chat page to reach a "ready to chat" state. Uses a generous
 * timeout because WebRTC ICE gathering can legitimately take 30-60 s under
 * emulator conditions before falling back to the Firestore relay.
 *
 * The ConnectionBanner's `.connection-banner-text` is the single authoritative
 * status element: it settles on 'P2P 已連線' (direct) or '備援模式' (relay) —
 * both are ready states. Targeting that one element (instead of a free-text
 * search) avoids strict-mode ambiguity with the chat's E2EE indicator, which
 * also contains the substring '備援模式'.
 */
export async function expectChatReady(page: Page, timeoutMs = 30_000): Promise<void> {
  await expect(page).toHaveURL(/\/chat\/.+/, { timeout: 15_000 });
  await expect(page.locator('.connection-banner-text')).toHaveText(/已連線|備援模式/, {
    timeout: timeoutMs,
  });
}

/**
 * Wait until E2EE is settled (encrypted, not mid-exchange) before sending.
 *
 * Post-ADR-0004, "connection ready" (ConnectionBanner says 已連線) is no longer
 * the same as "ready to send": ChatService now blocks sends until the sender-key
 * exchange completes. Sending during the 金鑰交換中 window makes the message wait
 * (or, under a tight test budget, appear to never arrive). Gating on the settled
 * indicator — the 🔒/🔓 variant is visible AND the exchanging variant is gone —
 * reflects the real send-readiness signal and removes round-trip flakiness.
 */
export async function expectE2EEReady(page: Page, timeoutMs = 20_000): Promise<void> {
  await expect(
    page.locator('.e2ee-indicator-p2p, .e2ee-indicator-fallback'),
  ).toBeVisible({ timeout: timeoutMs });
  await expect(page.locator('.e2ee-indicator-exchanging')).toHaveCount(0);
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
