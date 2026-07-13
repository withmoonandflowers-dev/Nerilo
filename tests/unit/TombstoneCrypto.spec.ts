/**
 * TombstoneCrypto 測試（ADR-0024 房籍簽章墓碑，盲信使可驗）
 *
 * 用真 ECDSA P-256 金鑰（SubtleCrypto，Node webcrypto）驗：
 *  - 簽→驗來回成立；senderId 與 IdentityManager.deriveUserId 導法一致。
 *  - 非成員（senderId 不在房紀錄集合）→ 拒。
 *  - 竄改簽章 / 跨房重放（roomA 的墓碑拿去刪 roomB）/ 畸形 proof → 拒。
 *
 * @vitest-environment node
 */
import { describe, it, expect } from 'vitest';
import { signTombstone, verifyTombstone, senderIdFromPubKey } from '../../src/core/relay/TombstoneCrypto';
import { arrayBufferToBase64 } from '../../src/utils/crypto';

async function makeMember() {
  const kp = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
    'sign',
    'verify',
  ]);
  const spki = await crypto.subtle.exportKey('spki', kp.publicKey);
  const pubKey = arrayBufferToBase64(spki);
  const senderId = await senderIdFromPubKey(pubKey);
  return { privateKey: kp.privateKey, pubKey, senderId };
}

describe('TombstoneCrypto', () => {
  it('簽→驗來回成立（senderId 在房紀錄集合中）', async () => {
    const m = await makeMember();
    const t = await signTombstone('room1', m.privateKey, m.pubKey);
    expect(t.roomId).toBe('room1');
    expect(await verifyTombstone(t, new Set([m.senderId]))).toBe(true);
  });

  it('senderId 與 deriveUserId 導法一致（hash(SPKI base64).slice(0,32)）', async () => {
    const m = await makeMember();
    expect(m.senderId).toHaveLength(32);
    expect(await senderIdFromPubKey(m.pubKey)).toBe(m.senderId);
  });

  it('非成員（senderId 不在集合）→ 拒（房籍關卡）', async () => {
    const m = await makeMember();
    const t = await signTombstone('room1', m.privateKey, m.pubKey);
    expect(await verifyTombstone(t, new Set(['someone-else']))).toBe(false);
    expect(await verifyTombstone(t, new Set())).toBe(false);
  });

  it('竄改簽章 → 拒（簽章關卡）', async () => {
    const m = await makeMember();
    const t = await signTombstone('room1', m.privateKey, m.pubKey);
    const tampered = { ...t, signature: t.signature.slice(0, -4) + 'AAAA' };
    expect(await verifyTombstone(tampered, new Set([m.senderId]))).toBe(false);
  });

  it('跨房重放（roomA 墓碑刪 roomB）→ 拒（簽章綁 roomId）', async () => {
    const m = await makeMember();
    const forRoomA = await signTombstone('roomA', m.privateKey, m.pubKey);
    // 把 roomId 改成 B 但沿用 A 的簽章 → 原像變、驗不過。
    const replay = { ...forRoomA, roomId: 'roomB' };
    expect(await verifyTombstone(replay, new Set([m.senderId]))).toBe(false);
  });

  it('別人的私鑰簽、冒用成員 pubKey → 拒（pubKey 與簽章不匹配）', async () => {
    const alice = await makeMember();
    const mallory = await makeMember();
    // mallory 簽，但把 pubKey 換成 alice 的（想冒充 alice 的房籍）。
    const forged = await signTombstone('room1', mallory.privateKey, alice.pubKey);
    // alice 是成員；但簽章是 mallory 私鑰做的，配 alice 公鑰驗不過。
    expect(await verifyTombstone(forged, new Set([alice.senderId]))).toBe(false);
  });

  it('畸形 proof（缺欄位/型別錯）→ 拒，不擲錯', async () => {
    const set = new Set(['x']);
    expect(await verifyTombstone({ roomId: 'r' } as never, set)).toBe(false);
    expect(await verifyTombstone({ roomId: 'r', pubKey: 123, signature: 's' } as never, set)).toBe(false);
    expect(await verifyTombstone(null as never, set)).toBe(false);
  });
});
