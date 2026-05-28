/**
 * P1 connection-state tests.
 *
 * Covers the ConnectionBanner + E2EE indicator across:
 *   - connecting → connected on initial join
 *   - 備援模式 (Firestore fallback) when P2P can't engage
 *   - E2EE indicator switches variants accordingly
 *
 * The fallback path is exercised by intercepting WebRTC offer/answer
 * exchanges so the DataChannel never opens; messages must still flow via
 * Firestore (and the encrypted-fallback indicator must light up).
 *
 * See docs/E2E_TEST_PLAN.md § P1.6–P1.8.
 */

import { test, expect } from '@playwright/test';
import {
  setupUser,
  teardown,
  createRoom,
  joinRoom,
  sendMessage,
  expectMessageReceived,
  uniqueMessage,
} from './_helpers/users';

test.describe('P1 connection states', () => {
  test('P1.6 banner shows 連線中 → 已連線 during normal join', async ({ browser }) => {
    const alice = await setupUser(browser);
    const bob = await setupUser(browser);
    try {
      const roomId = await createRoom(alice.page);
      await joinRoom(bob.page, roomId);

      // The banner element should pass through the connecting state at least
      // once. We don't strictly require to *see* it — fast connections may
      // skip the intermediate render — but it should eventually settle.
      await expect(alice.page).toHaveURL(/\/chat\/.+/, { timeout: 15_000 });
      await expect(bob.page).toHaveURL(/\/chat\/.+/, { timeout: 15_000 });

      // Final state must be "connected" with one of the mode labels (P2P 直連
      // / Mesh 中繼) — proves we're not stuck on the fallback path.
      await expect(alice.page.locator('.connection-banner.connected')).toBeVisible({ timeout: 30_000 });
      await expect(bob.page.locator('.connection-banner.connected')).toBeVisible({ timeout: 30_000 });
      await expect(alice.page.locator('.connection-banner-text')).toContainText(/P2P|Mesh|已連線/);
    } finally {
      await teardown(alice, bob);
    }
  });

  test('P1.7 when P2P signaling is blocked, fallback banner appears and messages flow', async ({ browser }) => {
    // Strategy: route-intercept WebRTC negotiation so the DataChannel never
    // opens. The simplest cross-engine signal is to drop RTCPeerConnection
    // entirely via init script — the app then has to use Firestore fallback.
    const alice = await setupUser(browser);
    const bob = await setupUser(browser);
    try {
      // Disable RTCPeerConnection on both peers before they navigate to the
      // chat page. Replace with a stub that immediately reports 'failed'
      // connection state so the app gives up on P2P quickly.
      const breakWebRTC = `
        const Original = window.RTCPeerConnection;
        window.RTCPeerConnection = function () {
          const pc = new Original(...arguments);
          // Simulate a peer that can never reach 'connected'.
          Object.defineProperty(pc, 'connectionState', { get: () => 'failed' });
          queueMicrotask(() => pc.onconnectionstatechange?.());
          return pc;
        };
      `;
      await alice.page.addInitScript(breakWebRTC);
      await bob.page.addInitScript(breakWebRTC);
      // Re-navigate so the init script takes effect.
      await alice.page.reload();
      await bob.page.reload();
      await expect(alice.page.locator('.role-badge')).toBeVisible({ timeout: 15_000 });
      await expect(bob.page.locator('.role-badge')).toBeVisible({ timeout: 15_000 });

      const roomId = await createRoom(alice.page);
      await joinRoom(bob.page, roomId);

      // Fallback banner must surface within a reasonable wait. P0.5's
      // expectChatReady accepts either state — here we require fallback.
      await expect(alice.page.getByText('備援模式')).toBeVisible({ timeout: 30_000 });
      await expect(bob.page.getByText('備援模式')).toBeVisible({ timeout: 30_000 });

      // P1.8: the E2EE indicator's fallback variant should be visible.
      await expect(alice.page.locator('.e2ee-indicator-fallback')).toBeVisible({ timeout: 10_000 });
      await expect(bob.page.locator('.e2ee-indicator-fallback')).toBeVisible({ timeout: 10_000 });

      // Messages still flow through the Firestore fallback path.
      const msg = uniqueMessage('fallback');
      await sendMessage(alice.page, msg);
      await expectMessageReceived(bob.page, msg, 20_000);
    } finally {
      await teardown(alice, bob);
    }
  });
});
