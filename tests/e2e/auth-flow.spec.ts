/**
 * Auth flow E2E — email register / login / logout / error messages.
 *
 * Runs against the Firebase Auth emulator (test mode connects to 127.0.0.1:9099),
 * so no real Firebase / Google account is needed.
 *
 * Why this exists: the email-auth flow (register toggle, register, login, logout,
 * friendly error mapping) had ZERO automated coverage. A config/UI regression —
 * e.g. dropping registerWithEmail, breaking the login⇄register toggle, or
 * reverting the error-code messages — would previously only be caught by a user.
 *
 * Scope note: production-only concerns (CSP blocking Firebase Auth scripts, the
 * Google OAuth redirect_uri) cannot be reproduced against the emulator and are
 * covered by Sentry observability instead, not by this test.
 *
 * Tagged @stable — runs in `npm run test:e2e:stable` (the deploy-gating subset).
 */

import { test, expect, type Page } from '@playwright/test';

const PASSWORD = 'Test123456';
const uniqueEmail = (tag: string) =>
  `e2e-${tag}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@nerilo-e2e.test`;

/** Switch the login page into register mode and confirm the toggle took. */
async function switchToRegister(page: Page): Promise<void> {
  await page.locator('.auth-toggle-link').click();
  await expect(page.locator('.login-form button[type="submit"]')).toHaveText('註冊');
}

async function submitEmailForm(page: Page, email: string, password: string): Promise<void> {
  await page.fill('#email', email);
  await page.fill('#password', password);
  await page.locator('.login-form button[type="submit"]').click();
}

test.describe('auth flow @stable', () => {
  test('register a new account lands on dashboard as role "user"', async ({ browser }) => {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    try {
      await page.goto('/login');
      await switchToRegister(page);
      await submitEmailForm(page, uniqueEmail('reg'), PASSWORD);

      await expect(page).toHaveURL(/\/dashboard/, { timeout: 15_000 });
      // Registered (non-anonymous) users get the 'user' role, not 'guest'.
      await expect(page.locator('.role-badge')).toContainText('user', { timeout: 5_000 });
    } finally {
      await ctx.close();
    }
  });

  test('register → logout → log back in with the same credentials', async ({ browser }) => {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    const email = uniqueEmail('roundtrip');
    try {
      // Register
      await page.goto('/login');
      await switchToRegister(page);
      await submitEmailForm(page, email, PASSWORD);
      await expect(page).toHaveURL(/\/dashboard/, { timeout: 15_000 });

      // Logout (returns to /login; no auto re-anonymous after explicit logout)
      await page.locator('.btn-logout').click();
      await expect(page).toHaveURL(/\/login/, { timeout: 10_000 });

      // Log in again (default login mode) with the same account
      await submitEmailForm(page, email, PASSWORD);
      await expect(page).toHaveURL(/\/dashboard/, { timeout: 15_000 });
      await expect(page.locator('.role-badge')).toContainText('user', { timeout: 5_000 });
    } finally {
      await ctx.close();
    }
  });

  test('logging in to a non-existent account shows a clear error (not a dead end)', async ({ browser }) => {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    try {
      await page.goto('/login');
      // stay in login mode; attempt a brand-new account that was never registered
      await submitEmailForm(page, uniqueEmail('ghost'), PASSWORD);

      const err = page.locator('.error-message');
      await expect(err).toBeVisible({ timeout: 10_000 });
      // Should be a human message, never the opaque raw "Firebase: Error (...)".
      await expect(err).not.toContainText('Firebase: Error');
      await expect(page).toHaveURL(/\/login/);
    } finally {
      await ctx.close();
    }
  });

  test('registering an already-used email guides the user to login', async ({ browser }) => {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    const email = uniqueEmail('dup');
    try {
      // First registration succeeds
      await page.goto('/login');
      await switchToRegister(page);
      await submitEmailForm(page, email, PASSWORD);
      await expect(page).toHaveURL(/\/dashboard/, { timeout: 15_000 });

      // Logout, then try to REGISTER the same email again → already-in-use
      await page.locator('.btn-logout').click();
      await expect(page).toHaveURL(/\/login/, { timeout: 10_000 });
      await switchToRegister(page);
      await submitEmailForm(page, email, PASSWORD);

      const err = page.locator('.error-message');
      await expect(err).toBeVisible({ timeout: 10_000 });
      await expect(err).toContainText('已註冊');
      await expect(page).toHaveURL(/\/login/);
    } finally {
      await ctx.close();
    }
  });
});
