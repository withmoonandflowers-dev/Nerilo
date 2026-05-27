/**
 * P1 refresh-recovery test.
 *
 * Verifies that the Dexie-backed message history actually persists across a
 * browser reload — a behaviour the README claims and that's easy to break.
 *
 * See docs/E2E_TEST_PLAN.md § P1.10.
 */

import { test, expect } from '@playwright/test';
import {
  setupUser,
  teardown,
  createRoom,
  joinRoom,
  expectChatReady,
  sendMessage,
  expectMessageReceived,
  uniqueMessage,
} from './_helpers/users';

test.describe('P1 refresh recovery', () => {
  test('P1.10 messages remain visible after a browser refresh', async ({ browser }) => {
    const alice = await setupUser(browser);
    const bob = await setupUser(browser);
    try {
      const roomId = await createRoom(alice.page);
      await joinRoom(bob.page, roomId);
      await expectChatReady(alice.page);
      await expectChatReady(bob.page);

      const msgs = [
        uniqueMessage('persisted-1'),
        uniqueMessage('persisted-2'),
        uniqueMessage('persisted-3'),
      ];
      for (const m of msgs) {
        await sendMessage(alice.page, m);
        await expectMessageReceived(bob.page, m);
      }

      // Refresh Bob's tab — the message list should reload from IndexedDB.
      await bob.page.reload();
      // After reload, the chat page re-initialises; wait for the input to be
      // ready as the proxy for "page hydrated".
      await expect(bob.page.getByPlaceholder('輸入訊息...')).toBeVisible({ timeout: 30_000 });

      // All three messages should still be visible on Bob's side.
      for (const m of msgs) {
        await expect(bob.page.getByText(m).first()).toBeVisible({ timeout: 15_000 });
      }
    } finally {
      await teardown(alice, bob);
    }
  });
});
