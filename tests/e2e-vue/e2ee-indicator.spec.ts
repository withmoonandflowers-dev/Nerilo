/**
 * ADR-0026 R2 明文降級 fail-visible：加密指示器必須反映「真實」加密狀態，
 * 不是連上就亮鎖頭的假徽章。正常房（ECDH 可用）金鑰交換完成後應顯示 e2ee-encrypted，
 * 且送訊不被明文閘門阻擋（encrypted → allow）。真明文房（ECDH 不可用）的阻斷式確認
 * 屬罕見降級環境，由 encryptionGate 純邏輯 + MeshGossipManager.getEncryptionState 單元測試覆蓋。
 */
import { test, expect } from '@playwright/test';
import {
  setupUser,
  createRoom,
  joinRoom,
  expectChatReady,
  sendMessage,
  uniqueMessage,
  expectExactlyOnce,
  teardown,
} from './_helpers/users';

test.describe('Vue 版加密指示器（誠實）', () => {
  test('正常房金鑰交換後顯示 encrypted，且明文閘門不擋加密送出', async ({ browser }) => {
    test.setTimeout(180_000);
    const alice = await setupUser(browser);
    const bob = await setupUser(browser);
    try {
      const roomId = await createRoom(alice.page);
      await joinRoom(bob.page, roomId);
      await expectChatReady(alice.page);
      await expectChatReady(bob.page);

      // 指示器最終為 e2ee-encrypted（真實已加密）——不是連上就亮的靜態鎖頭
      await expect(alice.page.getByTestId('e2ee-encrypted')).toBeVisible({ timeout: 30_000 });
      await expect(bob.page.getByTestId('e2ee-encrypted')).toBeVisible({ timeout: 30_000 });
      // 未加密警告與明文確認 bar 在正常房不該出現
      await expect(alice.page.getByTestId('plaintext-notice')).toHaveCount(0);
      await expect(alice.page.getByTestId('plaintext-confirm')).toHaveCount(0);

      // encrypted → 送訊直接放行（無阻斷確認），雙向各恰好一次
      const text = uniqueMessage('e2ee');
      await sendMessage(alice.page, text);
      await expectExactlyOnce(alice.page, text);
      await expectExactlyOnce(bob.page, text);
    } finally {
      await teardown(alice, bob);
    }
  });
});
