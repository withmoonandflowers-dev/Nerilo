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
