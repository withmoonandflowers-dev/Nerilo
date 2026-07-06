/**
 * RecordCrypto — property-based（fast-check）
 *
 * example-based 測試只驗你想到的輸入；property 測試對「任意輸入」驗不變量，
 * 專抓你沒想到的邊界（空字串、emoji、超長、JSON-like、控制字元…）。
 * 密碼學模組的不變量是天生標的。這也是 harden-tests skill 的示範樣板。
 */
import { describe, it } from 'vitest';
import fc from 'fast-check';
import {
  encryptRecordContent,
  decryptRecordContent,
  isEncryptedContent,
  contentEpoch,
} from '../../src/core/mesh/RecordCrypto';

async function freshKey(): Promise<CryptoKey> {
  return crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, [
    'encrypt',
    'decrypt',
  ]);
}

describe('RecordCrypto — 不變量（property）', () => {
  it('不變量：任意明文 round-trip 還原（decrypt∘encrypt = id）', async () => {
    const key = await freshKey();
    await fc.assert(
      fc.asyncProperty(fc.string(), fc.nat(1_000_000), async (plaintext, epoch) => {
        const content = await encryptRecordContent(plaintext, key, epoch);
        return (await decryptRecordContent(content, key)) === plaintext;
      }),
      { numRuns: 200 },
    );
  });

  it('不變量：密文不外洩明文（非空明文不出現在信封字串）', async () => {
    const key = await freshKey();
    await fc.assert(
      fc.asyncProperty(
        fc.string({ minLength: 4 }).filter((s) => s.trim().length >= 4),
        async (plaintext) => {
          const content = await encryptRecordContent(plaintext, key);
          return !content.includes(plaintext);
        },
      ),
      { numRuns: 150 },
    );
  });

  it('不變量：epoch 忠實往返（信封讀回的 ep 等於加密時給的）', async () => {
    const key = await freshKey();
    await fc.assert(
      fc.asyncProperty(fc.string(), fc.nat(2_000_000), async (pt, epoch) => {
        const content = await encryptRecordContent(pt, key, epoch);
        return contentEpoch(content) === epoch && isEncryptedContent(content);
      }),
      { numRuns: 150 },
    );
  });

  it('不變量：異金鑰恆解不開（跨房隔離對任意明文成立）', async () => {
    const a = await freshKey();
    const b = await freshKey();
    await fc.assert(
      fc.asyncProperty(fc.string(), async (pt) => {
        const content = await encryptRecordContent(pt, a);
        try {
          await decryptRecordContent(content, b);
          return false; // 不該解得開
        } catch {
          return true;
        }
      }),
      { numRuns: 100 },
    );
  });

  it('不變量：任意非密文字串都不被誤判為密文信封', async () => {
    fc.assert(
      fc.property(fc.string(), (s) => {
        // 明文即使長得像 JSON，也不含 nrec1 專屬結構 → 必為 false
        return isEncryptedContent(s) === false;
      }),
      { numRuns: 500 },
    );
  });
});
