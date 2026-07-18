import { describe, it, expect } from 'vitest';
import { SecurityManager } from '../../src/core/mesh/SecurityManager';
import { arrayBufferToBase64 } from '../../src/utils/crypto';
import type { GossipMessage } from '../../src/types';

// ── Helpers ─────────────────────────────────────────────────────────────────

/** Generate an ECDSA P-256 key pair */
async function generateSigningKeyPair(): Promise<CryptoKeyPair> {
  return crypto.subtle.generateKey(
    { name: 'ECDSA', namedCurve: 'P-256' },
    true,
    ['sign', 'verify'],
  );
}

/** Export a public key to SPKI Base64 (matching SecurityManager.importPublicKey) */
async function exportPubKeySpki(key: CryptoKey): Promise<string> {
  const spki = await crypto.subtle.exportKey('spki', key);
  return arrayBufferToBase64(spki);
}

/** Build a minimal GossipMessage without signature */
function makeUnsignedMessage(
  overrides: Partial<Omit<GossipMessage, 'signature'>> = {},
): Omit<GossipMessage, 'signature'> {
  return {
    roomId: 'room-1',
    senderId: 'sender-abc',
    pubKey: 'dummy-pub-key',
    seq: 1,
    sessionEpoch: 1,
    timestamp: Date.now(),
    content: 'hello world',
    ttl: 5,
    ...overrides,
  };
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe('SecurityManager', () => {
  const sm = new SecurityManager();

  describe('signMessage + verifyMessage round-trip', () => {
    it('signs and verifies a message successfully', async () => {
      const kp = await generateSigningKeyPair();
      const msg = makeUnsignedMessage({
        pubKey: await exportPubKeySpki(kp.publicKey),
      });

      const signature = await sm.signMessage(msg, kp.privateKey);
      expect(typeof signature).toBe('string');
      expect(signature.length).toBeGreaterThan(0);

      const signedMsg: GossipMessage = { ...msg, signature };
      const valid = await sm.verifyMessage(signedMsg, kp.publicKey);
      expect(valid).toBe(true);
    });
  });

  describe('importPublicKey 可匯出（回歸：extractable 導致 mesh 訊息全滅）', () => {
    it('匯入的公鑰必須能被 exportKey（deriveUserId 依賴此）', async () => {
      // 收訊時 IdentityManager.deriveUserId 會對匯入的公鑰做 exportKey('spki')
      // 驗證 pubKey↔senderId。若 importPublicKey 設 extractable:false，exportKey
      // 會擲錯，導致每則 gossip 訊息在身分驗證處炸掉、mesh 訊息完全不互通。
      const kp = await generateSigningKeyPair();
      const spkiB64 = await exportPubKeySpki(kp.publicKey);

      const imported = await sm.importPublicKey(spkiB64);
      // 這行在 extractable:false 時會 throw；修復後應成功且與原始一致
      const reExported = await crypto.subtle.exportKey('spki', imported);
      expect(arrayBufferToBase64(reExported)).toBe(spkiB64);
    });
  });

  describe('轉發副本簽章仍有效（回歸：簽章含 ttl 使所有轉發副本驗簽失敗）', () => {
    it('ttl 遞減後（gossip 轉發）驗簽必須通過', async () => {
      const kp = await generateSigningKeyPair();
      const msg = makeUnsignedMessage({
        pubKey: await exportPubKeySpki(kp.publicKey),
        ttl: 8,
      });
      const signature = await sm.signMessage(msg, kp.privateKey);

      // 模擬中繼節點轉發：ttl - 1，簽章不變
      const forwarded: GossipMessage = { ...msg, signature, ttl: msg.ttl - 1 };
      expect(await sm.verifyMessage(forwarded, kp.publicKey)).toBe(true);
    });
  });

  describe('channel 欄位有簽章保護（M4：防跨通道錯誤分發）', () => {
    it('把 chat 訊息竄改成 game 通道 → 驗簽失敗', async () => {
      const kp = await generateSigningKeyPair();
      const msg = makeUnsignedMessage({
        pubKey: await exportPubKeySpki(kp.publicKey),
        channel: 'chat',
      });
      const signature = await sm.signMessage(msg, kp.privateKey);

      const tampered: GossipMessage = { ...msg, signature, channel: 'game' };
      expect(await sm.verifyMessage(tampered, kp.publicKey)).toBe(false);
    });

    it('channel:game 正常簽驗 round-trip', async () => {
      const kp = await generateSigningKeyPair();
      const msg = makeUnsignedMessage({
        pubKey: await exportPubKeySpki(kp.publicKey),
        channel: 'game',
      });
      const signature = await sm.signMessage(msg, kp.privateKey);
      expect(await sm.verifyMessage({ ...msg, signature }, kp.publicKey)).toBe(true);
    });
  });

  describe('sessionEpoch 有簽章保護（Spec 009：跨會話重放收斂的根基）', () => {
    it('竄改 sessionEpoch → 驗簽失敗（舊會話訊息無法冒充新代）', async () => {
      const kp = await generateSigningKeyPair();
      const pubKey = await exportPubKeySpki(kp.publicKey);
      const unsigned = makeUnsignedMessage({ pubKey, sessionEpoch: 3 });
      const signature = await sm.signMessage(unsigned, kp.privateKey);

      const tampered: GossipMessage = { ...unsigned, sessionEpoch: 99, signature };
      const imported = await sm.importPublicKey(pubKey);
      expect(await sm.verifyMessage(tampered, imported, { maxAgeMs: null })).toBe(false);
    });

    it('sessionEpoch 正常簽驗 round-trip', async () => {
      const kp = await generateSigningKeyPair();
      const pubKey = await exportPubKeySpki(kp.publicKey);
      const unsigned = makeUnsignedMessage({ pubKey, sessionEpoch: 1752800000123 });
      const signature = await sm.signMessage(unsigned, kp.privateKey);
      const imported = await sm.importPublicKey(pubKey);
      expect(
        await sm.verifyMessage({ ...unsigned, signature }, imported, { maxAgeMs: null }),
      ).toBe(true);
    });
  });

  describe('tampered message detection', () => {
    it('fails verification when content is tampered', async () => {
      const kp = await generateSigningKeyPair();
      const msg = makeUnsignedMessage();

      const signature = await sm.signMessage(msg, kp.privateKey);
      const signedMsg: GossipMessage = { ...msg, signature };

      // Tamper with content
      signedMsg.content = 'tampered content';

      const valid = await sm.verifyMessage(signedMsg, kp.publicKey);
      expect(valid).toBe(false);
    });

    it('fails verification when seq is tampered', async () => {
      const kp = await generateSigningKeyPair();
      const msg = makeUnsignedMessage();

      const signature = await sm.signMessage(msg, kp.privateKey);
      const signedMsg: GossipMessage = { ...msg, signature };

      signedMsg.seq = 9999;

      const valid = await sm.verifyMessage(signedMsg, kp.publicKey);
      expect(valid).toBe(false);
    });
  });

  describe('replay protection — expired message', () => {
    it('rejects a message older than 5 minutes', async () => {
      const kp = await generateSigningKeyPair();
      const fiveMinAgo = Date.now() - 5 * 60 * 1000 - 1; // just over 5 min
      const msg = makeUnsignedMessage({ timestamp: fiveMinAgo });

      const signature = await sm.signMessage(msg, kp.privateKey);
      const signedMsg: GossipMessage = { ...msg, signature };

      const valid = await sm.verifyMessage(signedMsg, kp.publicKey);
      expect(valid).toBe(false);
    });

    it('accepts a message within 5-minute window', async () => {
      const kp = await generateSigningKeyPair();
      const fourMinAgo = Date.now() - 4 * 60 * 1000;
      const msg = makeUnsignedMessage({ timestamp: fourMinAgo });

      const signature = await sm.signMessage(msg, kp.privateKey);
      const signedMsg: GossipMessage = { ...msg, signature };

      const valid = await sm.verifyMessage(signedMsg, kp.publicKey);
      expect(valid).toBe(true);
    });
  });

  describe('時效窗可停用（回歸：補送舊訊息被時效拒絕、遲到者永久收不到）', () => {
    it('maxAgeMs: null 接受任意舊的訊息（anti-entropy 補送給遲到者）', async () => {
      const kp = await generateSigningKeyPair();
      const thirtyMinAgo = Date.now() - 30 * 60 * 1000;
      const msg = makeUnsignedMessage({ timestamp: thirtyMinAgo });

      const signature = await sm.signMessage(msg, kp.privateKey);
      const signedMsg: GossipMessage = { ...msg, signature };

      expect(await sm.verifyMessage(signedMsg, kp.publicKey)).toBe(false); // 預設仍拒
      expect(
        await sm.verifyMessage(signedMsg, kp.publicKey, { maxAgeMs: null }),
      ).toBe(true);
    });

    it('maxAgeMs: null 仍拒絕未來時間戳（合法補送只會帶過去時間）', async () => {
      const kp = await generateSigningKeyPair();
      const msg = makeUnsignedMessage({ timestamp: Date.now() + 31_000 });

      const signature = await sm.signMessage(msg, kp.privateKey);
      const signedMsg: GossipMessage = { ...msg, signature };

      expect(
        await sm.verifyMessage(signedMsg, kp.publicKey, { maxAgeMs: null }),
      ).toBe(false);
    });

    it('maxAgeMs: null 仍驗簽（停用時效 ≠ 停用完整性檢查）', async () => {
      const kp = await generateSigningKeyPair();
      const msg = makeUnsignedMessage({ timestamp: Date.now() - 30 * 60 * 1000 });

      const signature = await sm.signMessage(msg, kp.privateKey);
      const signedMsg: GossipMessage = { ...msg, signature, content: 'tampered' };

      expect(
        await sm.verifyMessage(signedMsg, kp.publicKey, { maxAgeMs: null }),
      ).toBe(false);
    });

    it('自訂 maxAgeMs 生效', async () => {
      const kp = await generateSigningKeyPair();
      const twoMinAgo = Date.now() - 2 * 60 * 1000;
      const msg = makeUnsignedMessage({ timestamp: twoMinAgo });

      const signature = await sm.signMessage(msg, kp.privateKey);
      const signedMsg: GossipMessage = { ...msg, signature };

      expect(
        await sm.verifyMessage(signedMsg, kp.publicKey, { maxAgeMs: 60_000 }),
      ).toBe(false);
      expect(
        await sm.verifyMessage(signedMsg, kp.publicKey, { maxAgeMs: 3 * 60_000 }),
      ).toBe(true);
    });
  });

  describe('replay protection — future timestamp', () => {
    it('rejects a message more than 30 seconds in the future', async () => {
      const kp = await generateSigningKeyPair();
      const future = Date.now() + 31_000; // 31s in future
      const msg = makeUnsignedMessage({ timestamp: future });

      const signature = await sm.signMessage(msg, kp.privateKey);
      const signedMsg: GossipMessage = { ...msg, signature };

      const valid = await sm.verifyMessage(signedMsg, kp.publicKey);
      expect(valid).toBe(false);
    });

    it('accepts a message up to 30 seconds in the future', async () => {
      const kp = await generateSigningKeyPair();
      const nearFuture = Date.now() + 29_000; // 29s in future
      const msg = makeUnsignedMessage({ timestamp: nearFuture });

      const signature = await sm.signMessage(msg, kp.privateKey);
      const signedMsg: GossipMessage = { ...msg, signature };

      const valid = await sm.verifyMessage(signedMsg, kp.publicKey);
      expect(valid).toBe(true);
    });
  });

  describe('invalid public key handling', () => {
    it('returns false for invalid Base64 public key via importPublicKey', async () => {
      await expect(
        sm.importPublicKey('not-valid-base64!!!'),
      ).rejects.toThrow();
    });

    it('returns false for empty string public key', async () => {
      await expect(
        sm.importPublicKey(''),
      ).rejects.toThrow();
    });

    it('returns false when verifying with wrong key', async () => {
      const kp1 = await generateSigningKeyPair();
      const kp2 = await generateSigningKeyPair();
      const msg = makeUnsignedMessage();

      const signature = await sm.signMessage(msg, kp1.privateKey);
      const signedMsg: GossipMessage = { ...msg, signature };

      // Verify with a different key pair
      const valid = await sm.verifyMessage(signedMsg, kp2.publicKey);
      expect(valid).toBe(false);
    });
  });
});
