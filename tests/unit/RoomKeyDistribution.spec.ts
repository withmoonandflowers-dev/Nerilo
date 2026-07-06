/**
 * 房間金鑰分發（ADR-0023 P2-②b）— 隔離協議驗證
 * 串起完整盲信使密碼學鏈：A 產生房間金鑰 → 封給 B → B 開出 → A 加密內容 → B 解密。
 * 非成員 C 既開不了金鑰、也解不了內容。keyx 紀錄對盲信使是不透明密文。
 */
import { describe, it, expect } from 'vitest';
import {
  generateRoomKey,
  sealRoomKeyForMember,
  openSealedRoomKey,
  sealRoomKeyForAll,
} from '../../src/core/mesh/RoomKeyDistribution';
import { encryptRecordContent, decryptRecordContent } from '../../src/core/mesh/RecordCrypto';

async function ecdhPair(): Promise<CryptoKeyPair> {
  return crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, [
    'deriveBits',
    'deriveKey',
  ]) as Promise<CryptoKeyPair>;
}

describe('RoomKeyDistribution — 金鑰分發協議', () => {
  it('A 封、B 開 → 得到同一把房間金鑰（內容加解密可互通）', async () => {
    const a = await ecdhPair();
    const b = await ecdhPair();

    const roomKey = await generateRoomKey();
    const sealed = await sealRoomKeyForMember(roomKey, 'B', 3, a.privateKey, b.publicKey);
    const bKey = await openSealedRoomKey(sealed, b.privateKey, a.publicKey);

    // 證明是同一把：A 用原金鑰加密、B 用開出的金鑰解密
    const content = await encryptRecordContent('A 對 B 說的密語', roomKey, 3);
    expect(await decryptRecordContent(content, bKey)).toBe('A 對 B 說的密語');
  });

  it('非成員 C 開不了 keyx（不同 ECDH 私鑰 → 拋錯）', async () => {
    const a = await ecdhPair();
    const b = await ecdhPair();
    const c = await ecdhPair(); // 局外人

    const roomKey = await generateRoomKey();
    const sealed = await sealRoomKeyForMember(roomKey, 'B', 1, a.privateKey, b.publicKey);

    // C 用自己的私鑰＋A 的公鑰 → 推不出同一把共享祕密 → 開不了
    await expect(openSealedRoomKey(sealed, c.privateKey, a.publicKey)).rejects.toBeTruthy();
  });

  it('盲信使視角：keyx 是不透明密文，存得到、開不了、也拿不到內容', async () => {
    const a = await ecdhPair();
    const b = await ecdhPair();

    const roomKey = await generateRoomKey();
    const sealed = await sealRoomKeyForMember(roomKey, 'B', 1, a.privateKey, b.publicKey);
    const content = await encryptRecordContent('會員祕密', roomKey);

    // 盲信使能原封保存 keyx 與內容密文（字串），但無 B 的私鑰 → 兩者都開不了
    const storedKeyx = JSON.stringify(sealed);
    const storedContent = content;
    expect(storedKeyx).not.toContain('會員祕密');
    expect(storedContent).not.toContain('會員祕密');
    // 成員 B 拿回原封 keyx → 開金鑰 → 解內容
    const bKey = await openSealedRoomKey(JSON.parse(storedKeyx), b.privateKey, a.publicKey);
    expect(await decryptRecordContent(storedContent, bKey)).toBe('會員祕密');
  });

  it('sealRoomKeyForAll：一次封給多成員，各自開出同一把', async () => {
    const owner = await ecdhPair();
    const m1 = await ecdhPair();
    const m2 = await ecdhPair();

    const roomKey = await generateRoomKey();
    const sealedAll = await sealRoomKeyForAll(roomKey, 2, owner.privateKey, [
      { userId: 'm1', ecdhPublic: m1.publicKey },
      { userId: 'm2', ecdhPublic: m2.publicKey },
    ]);
    expect(sealedAll.map((s) => s.forMember)).toEqual(['m1', 'm2']);

    const k1 = await openSealedRoomKey(sealedAll[0]!, m1.privateKey, owner.publicKey);
    const k2 = await openSealedRoomKey(sealedAll[1]!, m2.privateKey, owner.publicKey);
    const c = await encryptRecordContent('群發', roomKey, 2);
    expect(await decryptRecordContent(c, k1)).toBe('群發');
    expect(await decryptRecordContent(c, k2)).toBe('群發');
  });

  it('epoch 隔離：不同 epoch 各封各的，開出對應金鑰', async () => {
    const a = await ecdhPair();
    const b = await ecdhPair();
    const key1 = await generateRoomKey();
    const key2 = await generateRoomKey(); // 輪替後的新金鑰

    const s1 = await sealRoomKeyForMember(key1, 'B', 1, a.privateKey, b.publicKey);
    const s2 = await sealRoomKeyForMember(key2, 'B', 2, a.privateKey, b.publicKey);
    expect(s1.epoch).toBe(1);
    expect(s2.epoch).toBe(2);

    const b1 = await openSealedRoomKey(s1, b.privateKey, a.publicKey);
    const c1 = await encryptRecordContent('epoch1', key1, 1);
    expect(await decryptRecordContent(c1, b1)).toBe('epoch1');
    // 用 epoch1 的金鑰解 epoch2 內容 → 失敗（金鑰不符）
    const c2 = await encryptRecordContent('epoch2', key2, 2);
    await expect(decryptRecordContent(c2, b1)).rejects.toBeTruthy();
  });
});
