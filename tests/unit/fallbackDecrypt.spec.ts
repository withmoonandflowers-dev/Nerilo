/**
 * Spec 012 實作期修訂三：備援密文的有界等待解密。
 * 服務晚就緒／金鑰晚就緒 → 輪詢等到成功；逾時仍不行才拋錯。
 */
import { describe, it, expect } from 'vitest';
import { boundedFallbackDecrypt } from '../../src/features/chat/fallbackDecrypt';
import type { FallbackEncryptedContent } from '../../src/services/FirestoreChatFallback';

const payload: FallbackEncryptedContent = { ciphertext: 'ct', iv: 'iv', senderKeyEpoch: 0 };

describe('boundedFallbackDecrypt', () => {
  it('服務晚就緒：等到 resolve 非空後解密成功', async () => {
    let svc: { decryptFromFallback: () => Promise<string> } | null = null;
    setTimeout(() => { svc = { decryptFromFallback: async () => '明文' }; }, 120);
    const decrypt = boundedFallbackDecrypt(() => svc as never, { timeoutMs: 2_000, pollMs: 30 });
    await expect(decrypt(payload, 's1')).resolves.toBe('明文');
  });

  it('金鑰晚就緒：先失敗後成功 → 重試取得明文', async () => {
    let ready = false;
    setTimeout(() => { ready = true; }, 120);
    const svc = {
      decryptFromFallback: async () => {
        if (!ready) throw new Error('no room key for fallback decrypt');
        return '遲到的明文';
      },
    };
    const decrypt = boundedFallbackDecrypt(() => svc, { timeoutMs: 2_000, pollMs: 30 });
    await expect(decrypt(payload, 's1')).resolves.toBe('遲到的明文');
  });

  it('逾時服務仍未就緒 → 拋 notReadyMessage', async () => {
    const decrypt = boundedFallbackDecrypt(() => null, { timeoutMs: 200, pollMs: 30, notReadyMessage: 'svc not ready' });
    await expect(decrypt(payload, 's1')).rejects.toThrow('svc not ready');
  });

  it('逾時仍解不開（缺 epoch 金鑰）→ 拋最後一次解密錯誤', async () => {
    const svc = { decryptFromFallback: async () => { throw new Error('no room key'); } };
    const decrypt = boundedFallbackDecrypt(() => svc, { timeoutMs: 200, pollMs: 30 });
    await expect(decrypt(payload, 's1')).rejects.toThrow('no room key');
  });
});
