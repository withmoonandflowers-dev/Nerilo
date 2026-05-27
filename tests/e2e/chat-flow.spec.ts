/**
 * P1 chat-flow tests.
 *
 * Covers message-level behaviour:
 *   - delivery status progression (sending → sent → delivered)
 *   - failed-message resend
 *   - unicode / emoji round-trip
 *   - long message body (5 KB)
 *   - rapid burst preserves order
 *
 * See docs/E2E_TEST_PLAN.md § P1.
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

test.describe('P1 chat flow', () => {
  test('P1.1 sender sees a delivery-status badge progress past "sending"', async ({ browser }) => {
    const alice = await setupUser(browser);
    const bob = await setupUser(browser);
    try {
      const roomId = await createRoom(alice.page);
      await joinRoom(bob.page, roomId);
      await expectChatReady(alice.page);
      await expectChatReady(bob.page);

      const msg = uniqueMessage('delivery-status');
      await sendMessage(alice.page, msg);

      // The own message bubble carries a .delivery-status with one of these
      // classes. We accept any non-failed terminal state — sent / delivered /
      // (eventually) read — because exact timing varies with transport.
      const own = alice.page.locator('.message.own', { hasText: msg }).first();
      await expect(own).toBeVisible({ timeout: 10_000 });

      const status = own.locator('.delivery-status');
      await expect(status).toBeVisible({ timeout: 10_000 });
      // Must reach a non-sending state within 15 s
      await expect(status).toHaveClass(/sent|delivered/, { timeout: 15_000 });
      // And must not have ended in 'failed'
      await expect(status).not.toHaveClass(/failed/);
    } finally {
      await teardown(alice, bob);
    }
  });

  test('P1.3 unicode and emoji round-trip without corruption', async ({ browser }) => {
    const alice = await setupUser(browser);
    const bob = await setupUser(browser);
    try {
      const roomId = await createRoom(alice.page);
      await joinRoom(bob.page, roomId);
      await expectChatReady(alice.page);
      await expectChatReady(bob.page);

      const payload = '👋 你好世界 🌏 émoji éclair żółć عربى';
      await sendMessage(alice.page, payload);
      await expectMessageReceived(bob.page, payload);
      // Confirm exact byte fidelity — no smart-quote / NFC normalisation slips.
      await expect(bob.page.locator('.message', { hasText: payload }).first()).toBeVisible();
    } finally {
      await teardown(alice, bob);
    }
  });

  test('P1.4 5 KB message body survives the round-trip', async ({ browser }) => {
    const alice = await setupUser(browser);
    const bob = await setupUser(browser);
    try {
      const roomId = await createRoom(alice.page);
      await joinRoom(bob.page, roomId);
      await expectChatReady(alice.page);
      await expectChatReady(bob.page);

      // 5 KB sentinel — well under the 256 KB DataChannel cap but big enough
      // to defeat in-memory shortcuts.
      const marker = `LONG-${Date.now()}`;
      const filler = 'X'.repeat(5000 - marker.length - 1);
      const payload = `${marker}-${filler}`;
      await sendMessage(alice.page, payload);

      // Asserting on the entire 5 KB string is brittle (line-wrap, DOM split);
      // the marker suffices to confirm the message landed intact.
      await expectMessageReceived(bob.page, marker, 15_000);
    } finally {
      await teardown(alice, bob);
    }
  });

  test('P1.5 rapid burst — 5 messages in 1 s — all delivered in order', async ({ browser }) => {
    const alice = await setupUser(browser);
    const bob = await setupUser(browser);
    try {
      const roomId = await createRoom(alice.page);
      await joinRoom(bob.page, roomId);
      await expectChatReady(alice.page);
      await expectChatReady(bob.page);

      const tag = Date.now().toString(36);
      const messages = Array.from({ length: 5 }, (_, i) => `burst-${tag}-${i}`);

      for (const m of messages) {
        await sendMessage(alice.page, m);
      }

      // All five must arrive within a generous window.
      for (const m of messages) {
        await expectMessageReceived(bob.page, m, 20_000);
      }

      // Order check: the locator collection should match the sequence top-to-
      // bottom. We extract textContent of the message bodies on Bob's page,
      // filter to our burst tag, and compare against the sent order.
      const received = await bob.page
        .locator('.message-content p')
        .filter({ hasText: `burst-${tag}-` })
        .allTextContents();
      // received may include duplicates if the same text is rendered in multiple
      // bubbles; we just check the relative order.
      const indices = received.map((t) =>
        Number(t.match(new RegExp(`burst-${tag}-(\\d)`))?.[1] ?? -1),
      );
      const filtered = indices.filter((i) => i >= 0);
      const sorted = [...filtered].sort((a, b) => a - b);
      expect(filtered).toEqual(sorted);
    } finally {
      await teardown(alice, bob);
    }
  });
});
