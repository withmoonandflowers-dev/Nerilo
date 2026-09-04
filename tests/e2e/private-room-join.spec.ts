/**
 * R11 private-room invitation regression.
 *
 * A private room must remain unreadable before membership while a user holding
 * its invitation URL can join through the product flow. Both peers must leave
 * the waiting route and reach chat after the second participant joins.
 */

import { test, expect } from '@playwright/test';
import { setupUser, teardown, createRoom, joinRoom } from './_helpers/users';

test.describe('R11 private room invitation @release', () => {
  test('invited user joins a private room and both peers reach chat', async ({ browser }) => {
    const alice = await setupUser(browser);
    const bob = await setupUser(browser);
    try {
      const roomId = await createRoom(alice.page, { privateRoom: true });
      await joinRoom(bob.page, roomId);

      await expect(alice.page).toHaveURL(`/chat/${roomId}`, { timeout: 15_000 });
      await expect(bob.page).toHaveURL(`/chat/${roomId}`, { timeout: 15_000 });
    } finally {
      await teardown(alice, bob);
    }
  });
});
