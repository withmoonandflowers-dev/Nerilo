/**
 * P1 multi-peer mesh test.
 *
 * 3 peers all see each other's messages — verifies that the post-stress-test
 * meshIdentities rule fix (commit b0b1204) didn't break the basic mesh.
 *
 * See docs/E2E_TEST_PLAN.md § P1.9.
 */

import { test } from '@playwright/test';
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

test.describe('P1 multi-peer', () => {
  test('P1.9 3-peer mesh — each peer sees every other peer\'s messages', async ({ browser }) => {
    test.setTimeout(180_000); // mesh setup with emulator can take a while

    const alice = await setupUser(browser);
    const bob = await setupUser(browser);
    const carol = await setupUser(browser);
    try {
      const roomId = await createRoom(alice.page);
      await joinRoom(bob.page, roomId);
      await joinRoom(carol.page, roomId);

      await expectChatReady(alice.page, 60_000);
      await expectChatReady(bob.page, 60_000);
      await expectChatReady(carol.page, 60_000);

      // Each peer sends one tagged message.
      const aMsg = uniqueMessage('A says');
      const bMsg = uniqueMessage('B says');
      const cMsg = uniqueMessage('C says');

      await sendMessage(alice.page, aMsg);
      await sendMessage(bob.page, bMsg);
      await sendMessage(carol.page, cMsg);

      // All three messages should appear on all three peers.
      for (const peer of [alice, bob, carol]) {
        await expectMessageReceived(peer.page, aMsg, 20_000);
        await expectMessageReceived(peer.page, bMsg, 20_000);
        await expectMessageReceived(peer.page, cMsg, 20_000);
      }
    } finally {
      await teardown(alice, bob, carol);
    }
  });
});
