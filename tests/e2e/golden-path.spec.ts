/**
 * P0 golden-path E2E tests.
 *
 * Covers: anon login → dashboard → create room → second user joins via link
 *         → both connected → message round-trip → E2EE indicator visible
 *         → leave room.
 *
 * Tagged @stable — `npm run test:e2e:stable` runs only these.
 * If any test here fails, no deploy should proceed.
 *
 * See docs/E2E_TEST_PLAN.md for the full plan.
 */

import { test, expect } from '@playwright/test';
import {
  setupUser,
  teardown,
  createRoom,
  joinRoom,
  expectChatReady,
  expectE2EEReady,
  sendMessage,
  expectMessageReceived,
  uniqueMessage,
} from './_helpers/users';

test.describe('P0 golden path @stable', () => {
  test('P0.1 anonymous user lands on dashboard with role badge', async ({ browser }) => {
    const alice = await setupUser(browser);
    try {
      // role-badge already verified by setupUser; assert the create-room button
      // is also present so we know auth was admitted enough to render UI.
      await expect(alice.page.getByRole('button', { name: '+ 建立新房間' })).toBeVisible();
    } finally {
      await teardown(alice);
    }
  });

  test('P0.2 host creates a room and lands on the waiting page', async ({ browser }) => {
    const alice = await setupUser(browser);
    try {
      const roomId = await createRoom(alice.page);
      expect(roomId).toBeTruthy();
      expect(roomId.length).toBeGreaterThan(5);
      await expect(alice.page.getByText('等待連線')).toBeVisible();
      await expect(alice.page.getByText('等待其他人加入...')).toBeVisible();
    } finally {
      await teardown(alice);
    }
  });

  test('P0.3 second user joins via link and both land on chat', async ({ browser }) => {
    const alice = await setupUser(browser);
    const bob = await setupUser(browser);
    try {
      const roomId = await createRoom(alice.page);
      await joinRoom(bob.page, roomId);

      // Bob's join flips the room from waiting → open; both should land on chat.
      await expect(alice.page).toHaveURL(/\/chat\/.+/, { timeout: 15_000 });
      await expect(bob.page).toHaveURL(/\/chat\/.+/, { timeout: 15_000 });

      // Both peers reach a "ready" state — either P2P connected or fallback.
      await expectChatReady(alice.page);
      await expectChatReady(bob.page);
    } finally {
      await teardown(alice, bob);
    }
  });

  test('P0.4 message round-trip — A sends, B receives', async ({ browser }) => {
    const alice = await setupUser(browser);
    const bob = await setupUser(browser);
    try {
      const roomId = await createRoom(alice.page);
      await joinRoom(bob.page, roomId);
      await expectChatReady(alice.page);
      await expectChatReady(bob.page);
      // 金鑰交換完成才是發送閘門（ADR-0004）
      await expectE2EEReady(alice.page);
      await expectE2EEReady(bob.page);

      const msgAtoB = uniqueMessage('A→B hello');
      await sendMessage(alice.page, msgAtoB);
      await expectMessageReceived(bob.page, msgAtoB);

      const msgBtoA = uniqueMessage('B→A reply');
      await sendMessage(bob.page, msgBtoA);
      await expectMessageReceived(alice.page, msgBtoA);
    } finally {
      await teardown(alice, bob);
    }
  });

  test('P0.5 E2EE indicator is visible when chat is connected', async ({ browser }) => {
    const alice = await setupUser(browser);
    const bob = await setupUser(browser);
    try {
      const roomId = await createRoom(alice.page);
      await joinRoom(bob.page, roomId);
      await expectChatReady(alice.page);
      await expectChatReady(bob.page);

      // Both peers should see either the P2P or the fallback variant of the
      // indicator. Either one means "the user has been told the channel is
      // encrypted." The locator covers both classes.
      const indicator = (page: typeof alice.page) =>
        page.locator('.e2ee-indicator-p2p, .e2ee-indicator-fallback');

      await expect(indicator(alice.page)).toBeVisible({ timeout: 10_000 });
      await expect(indicator(bob.page)).toBeVisible({ timeout: 10_000 });

      // The text must include 加密 (encrypt) so a copy-rewrite that broke the
      // meaning would fail the test.
      await expect(indicator(alice.page)).toContainText(/加密/);
      await expect(indicator(bob.page)).toContainText(/加密/);
    } finally {
      await teardown(alice, bob);
    }
  });

  test('P0.6 leaving a room returns the user to dashboard', async ({ browser }) => {
    const alice = await setupUser(browser);
    const bob = await setupUser(browser);
    try {
      const roomId = await createRoom(alice.page);
      await joinRoom(bob.page, roomId);
      await expectChatReady(alice.page);
      await expectChatReady(bob.page);

      // Alice leaves via the back button in the chat header.
      await alice.page.getByRole('button', { name: '返回儀表板' }).click();
      await expect(alice.page).toHaveURL(/\/dashboard$/, { timeout: 10_000 });

      // Bob's chat page should remain usable (the room stays open while at
      // least one participant is present).
      await expect(bob.page).toHaveURL(/\/chat\/.+/);
      await expect(bob.page.getByPlaceholder('輸入訊息...')).toBeVisible();
    } finally {
      await teardown(alice, bob);
    }
  });
});
