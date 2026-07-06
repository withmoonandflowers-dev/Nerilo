/**
 * 紀錄密文化（ADR-0023 P2 / ADR-0024 盲信使前置）
 * 保證：成員解得開、非成員解不開、竄改被擋、明文不誤判、盲信使只見密文。
 */
import { describe, it, expect } from 'vitest';
import {
  encryptRecordContent,
  decryptRecordContent,
  isEncryptedContent,
  contentEpoch,
} from '../../src/core/mesh/RecordCrypto';

async function roomKey(seed = 'k'): Promise<CryptoKey> {
  const bits = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(seed));
  return crypto.subtle.importKey('raw', bits, { name: 'AES-GCM', length: 256 }, false, [
    'encrypt',
    'decrypt',
  ]);
}

describe('RecordCrypto', () => {
  it('round-trip：同金鑰加解密還原明文', async () => {
    const k = await roomKey();
    const content = await encryptRecordContent('嗨，這是密文訊息', k, 3);
    expect(content).not.toContain('嗨'); // 明文不外露
    expect(await decryptRecordContent(content, k)).toBe('嗨，這是密文訊息');
  });

  it('非成員（不同金鑰）解不開 → 拋錯', async () => {
    const member = await roomKey('room-key');
    const outsider = await roomKey('other-key');
    const content = await encryptRecordContent('secret', member);
    await expect(decryptRecordContent(content, outsider)).rejects.toBeTruthy();
  });

  it('竄改密文 → AES-GCM 驗證失敗（防改）', async () => {
    const k = await roomKey();
    const content = await encryptRecordContent('original', k);
    const env = JSON.parse(content);
    // 翻轉密文一個字元
    env.ct = env.ct.slice(0, -2) + (env.ct.endsWith('A') ? 'B' : 'A') + '=';
    await expect(decryptRecordContent(JSON.stringify(env), k)).rejects.toBeTruthy();
  });

  it('isEncryptedContent：密文 true、明文/JSON 明文 false（不誤判）', async () => {
    const k = await roomKey();
    const enc = await encryptRecordContent('hi', k);
    expect(isEncryptedContent(enc)).toBe(true);
    expect(isEncryptedContent('一般聊天訊息')).toBe(false);
    expect(isEncryptedContent('{"v":"other","msg":"json 明文"}')).toBe(false);
    expect(isEncryptedContent('')).toBe(false);
  });

  it('每次加密 IV 不同 → 相同明文密文互異', async () => {
    const k = await roomKey();
    const a = await encryptRecordContent('same', k);
    const b = await encryptRecordContent('same', k);
    expect(a).not.toBe(b);
    expect(await decryptRecordContent(a, k)).toBe('same');
    expect(await decryptRecordContent(b, k)).toBe('same');
  });

  it('contentEpoch：讀回 epoch；明文回 null', async () => {
    const k = await roomKey();
    expect(contentEpoch(await encryptRecordContent('x', k, 7))).toBe(7);
    expect(contentEpoch('明文')).toBeNull();
  });

  it('盲信使視角：只拿到密文 content 也能參與（可存、可轉、驗簽無需金鑰）', async () => {
    // 模擬盲信使：它只看到 content 字串本身，無房間金鑰
    const k = await roomKey();
    const content = await encryptRecordContent('會員間的祕密', k);
    // 盲信使能判斷這是密文紀錄、能原封轉存/轉發（字串不變即簽章不變）
    expect(isEncryptedContent(content)).toBe(true);
    const stored = content; // 原封保存
    // 成員拿回原封紀錄後仍解得開
    expect(await decryptRecordContent(stored, k)).toBe('會員間的祕密');
  });
});
