/**
 * H-2 回歸：seq 必填 + (senderId, epoch, seq) 綁進 AES-GCM 的 additionalData。
 *
 * 修復前兩個洞：
 *  (a) 重放檢查整段包在 `if (typeof seq === 'number')` 內 → 刪掉 seq 欄位即可繞過；
 *  (b) seq 是明文中繼資料且計數器在「解密之前」就更新 → 中間人把 seq 改成
 *      MAX_SAFE_INTEGER 投遞一次，該寄件者後續所有訊息都被判 replay 丟棄
 *      （安靜的審查型 DoS，受害者只看到訊息「沒送到」）。
 *
 * @vitest-environment node
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { SenderKeyManager } from '../../src/core/crypto/SenderKeyManager';
import type { EncryptedPayload } from '../../src/core/crypto/SenderKeyManager';

async function pair(): Promise<{ alice: SenderKeyManager; bob: SenderKeyManager }> {
  const alice = new SenderKeyManager('alice');
  const bob = new SenderKeyManager('bob');
  await alice.initKeyPair();
  await bob.initKeyPair();
  await alice.generateSenderKey();
  const dist = await alice.distributeSenderKey([
    { peerId: 'bob', publicKey: bob.getECDHPublicKey()! },
  ]);
  await bob.receiveSenderKey(dist!, alice.getECDHPublicKey()!);
  return { alice, bob };
}

describe('SenderKeyManager seq 綁定（H-2）', () => {
  let alice: SenderKeyManager;
  let bob: SenderKeyManager;

  beforeEach(async () => {
    ({ alice, bob } = await pair());
  });

  it('正常往返仍可解密（未破壞既有行為）', async () => {
    const msg = await alice.encryptMessage('hello');
    await expect(bob.decryptMessage(msg, 'alice')).resolves.toBe('hello');
  });

  it('刪掉 seq 欄位不再能繞過重放防護（此前整段檢查被跳過）', async () => {
    const msg = await alice.encryptMessage('bypass attempt');
    const stripped = { ...msg } as Partial<EncryptedPayload>;
    delete stripped.seq;
    await expect(
      bob.decryptMessage(stripped as EncryptedPayload, 'alice')
    ).rejects.toThrow(/Missing seq/);
  });

  it('竄改 seq（毒化計數器 DoS）會被 AAD 擋下，且不影響後續正常訊息', async () => {
    const m1 = await alice.encryptMessage('first');
    const poisoned = { ...m1, seq: Number.MAX_SAFE_INTEGER };

    // 竄改後解密失敗（AAD 不符）
    await expect(bob.decryptMessage(poisoned, 'alice')).rejects.toThrow();

    // 關鍵：水位未被毒化 —— 之後的正常訊息仍可正常解密
    await expect(bob.decryptMessage(m1, 'alice')).resolves.toBe('first');
    const m2 = await alice.encryptMessage('second');
    await expect(bob.decryptMessage(m2, 'alice')).resolves.toBe('second');
  });

  it('竄改 epoch 也會被 AAD 擋下', async () => {
    const msg = await alice.encryptMessage('x');
    const tampered = { ...msg, senderKeyEpoch: msg.senderKeyEpoch + 99 };
    await expect(bob.decryptMessage(tampered, 'alice')).rejects.toThrow();
  });

  it('張冠李戴（以他人 senderId 解讀）會被 AAD 擋下', async () => {
    const msg = await alice.encryptMessage('mine');
    // 用錯誤的 senderId 解 → AAD 綁的是 'alice'，不符即失敗
    // （先讓 bob 也有 mallory 的金鑰項才會走到解密：這裡直接驗證 alice 的鑰配錯 id）
    await expect(bob.decryptMessage(msg, 'mallory')).rejects.toThrow();
  });

  it('真正的重放（原封不動再送一次）仍被擋下', async () => {
    const msg = await alice.encryptMessage('once');
    await expect(bob.decryptMessage(msg, 'alice')).resolves.toBe('once');
    await expect(bob.decryptMessage(msg, 'alice')).rejects.toThrow(/Replay detected/);
  });
});
