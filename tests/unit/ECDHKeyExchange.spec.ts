import { describe, it, expect } from 'vitest';
import {
  deriveSharedSecret,
  encryptForPeer,
  decryptFromPeer,
} from '../../src/core/crypto/ECDHKeyExchange';

async function generateECDHKeyPair(): Promise<CryptoKeyPair> {
  return crypto.subtle.generateKey(
    { name: 'ECDH', namedCurve: 'P-256' },
    false,
    ['deriveKey', 'deriveBits']
  );
}

describe('ECDHKeyExchange', () => {
  describe('deriveSharedSecret()', () => {
    it('should derive the same shared secret from both sides', async () => {
      const alice = await generateECDHKeyPair();
      const bob = await generateECDHKeyPair();

      const secretAB = await deriveSharedSecret(alice.privateKey, bob.publicKey);
      const secretBA = await deriveSharedSecret(bob.privateKey, alice.publicKey);

      // Encrypt with Alice's derived key, decrypt with Bob's
      const plaintext = new TextEncoder().encode('hello world');
      const { ciphertext, iv } = await encryptForPeer(plaintext.buffer, secretAB);
      const decrypted = await decryptFromPeer(ciphertext, iv, secretBA);

      expect(new TextDecoder().decode(decrypted)).toBe('hello world');
    });

    it('should produce a CryptoKey with AES-GCM algorithm', async () => {
      const alice = await generateECDHKeyPair();
      const bob = await generateECDHKeyPair();

      const secret = await deriveSharedSecret(alice.privateKey, bob.publicKey);
      expect(secret.algorithm).toMatchObject({ name: 'AES-GCM', length: 256 });
    });
  });

  describe('encryptForPeer / decryptFromPeer', () => {
    it('should roundtrip encrypt/decrypt', async () => {
      const alice = await generateECDHKeyPair();
      const bob = await generateECDHKeyPair();
      const secret = await deriveSharedSecret(alice.privateKey, bob.publicKey);

      const original = 'sensitive message 12345';
      const data = new TextEncoder().encode(original).buffer;

      const { ciphertext, iv } = await encryptForPeer(data, secret);
      expect(ciphertext.byteLength).toBeGreaterThan(0);
      expect(iv.byteLength).toBe(12);

      const decrypted = await decryptFromPeer(ciphertext, iv, secret);
      expect(new TextDecoder().decode(decrypted)).toBe(original);
    });

    it('should fail to decrypt with wrong key', async () => {
      const alice = await generateECDHKeyPair();
      const bob = await generateECDHKeyPair();
      const eve = await generateECDHKeyPair();

      const secretAB = await deriveSharedSecret(alice.privateKey, bob.publicKey);
      const secretAE = await deriveSharedSecret(alice.privateKey, eve.publicKey);

      const data = new TextEncoder().encode('secret').buffer;
      const { ciphertext, iv } = await encryptForPeer(data, secretAB);

      // Eve's key should fail
      await expect(
        decryptFromPeer(ciphertext, iv, secretAE)
      ).rejects.toThrow();
    });

    it('should produce different ciphertext each time (random IV)', async () => {
      const alice = await generateECDHKeyPair();
      const bob = await generateECDHKeyPair();
      const secret = await deriveSharedSecret(alice.privateKey, bob.publicKey);

      const data = new TextEncoder().encode('same message').buffer;
      const result1 = await encryptForPeer(data, secret);
      const result2 = await encryptForPeer(data, secret);

      // IVs should differ
      expect(Buffer.from(result1.iv).toString('hex')).not.toBe(
        Buffer.from(result2.iv).toString('hex')
      );
    });
  });
});
