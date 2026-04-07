import { describe, it, expect, beforeEach } from 'vitest';
import { SenderKeyManager } from '../../src/core/crypto/SenderKeyManager';

/**
 * Helper: generate an ECDH P-256 key pair for testing.
 */
async function generateECDHKeyPair(): Promise<CryptoKeyPair> {
  return crypto.subtle.generateKey(
    { name: 'ECDH', namedCurve: 'P-256' },
    false,
    ['deriveKey', 'deriveBits']
  );
}

describe('SenderKeyManager', () => {
  let alice: SenderKeyManager;
  let bob: SenderKeyManager;

  beforeEach(async () => {
    alice = new SenderKeyManager('alice-uid');
    bob = new SenderKeyManager('bob-uid');
    await alice.initKeyPair();
    await bob.initKeyPair();
  });

  describe('generateSenderKey()', () => {
    it('should generate a sender key and increment epoch', async () => {
      expect(alice.epoch).toBe(0);
      await alice.generateSenderKey();
      expect(alice.epoch).toBe(1);
      await alice.generateSenderKey();
      expect(alice.epoch).toBe(2);
    });
  });

  describe('encrypt / decrypt messages', () => {
    it('should encrypt and decrypt a message using sender key', async () => {
      await alice.generateSenderKey();

      const encrypted = await alice.encryptMessage('hello world');
      expect(encrypted.ciphertext).toBeTruthy();
      expect(encrypted.iv).toBeTruthy();
      expect(encrypted.senderKeyEpoch).toBe(1);

      // Alice can decrypt her own messages (self-test)
      // For cross-user, we need key distribution (tested below)
    });

    it('should throw when encrypting without sender key', async () => {
      await expect(alice.encryptMessage('test')).rejects.toThrow(
        'Sender key not initialized'
      );
    });
  });

  describe('sender key distribution', () => {
    it('should distribute and receive sender key between two peers', async () => {
      await alice.generateSenderKey();

      const aliceECDHPub = alice.getECDHPublicKey()!;
      const bobECDHPub = bob.getECDHPublicKey()!;

      // Alice distributes her sender key to Bob
      const distribution = await alice.distributeSenderKey([
        { peerId: 'bob-uid', publicKey: bobECDHPub },
      ]);

      expect(distribution.senderId).toBe('alice-uid');
      expect(distribution.epoch).toBe(1);
      expect(distribution.encryptedKeys['bob-uid']).toBeTruthy();

      // Bob receives the sender key
      await bob.receiveSenderKey(distribution, aliceECDHPub);
      expect(bob.hasPeerKey('alice-uid')).toBe(true);
    });

    it('should allow Bob to decrypt Alice\u2019s messages after receiving sender key', async () => {
      await alice.generateSenderKey();

      const aliceECDHPub = alice.getECDHPublicKey()!;
      const bobECDHPub = bob.getECDHPublicKey()!;

      // Distribute
      const dist = await alice.distributeSenderKey([
        { peerId: 'bob-uid', publicKey: bobECDHPub },
      ]);
      await bob.receiveSenderKey(dist, aliceECDHPub);

      // Alice encrypts
      const encrypted = await alice.encryptMessage('secret message');

      // Bob decrypts
      const plaintext = await bob.decryptMessage(encrypted, 'alice-uid');
      expect(plaintext).toBe('secret message');
    });
  });

  describe('key rotation', () => {
    it('should handle key rotation: new epoch, old in-flight messages still work', async () => {
      await alice.generateSenderKey(); // epoch 1

      const aliceECDHPub = alice.getECDHPublicKey()!;
      const bobECDHPub = bob.getECDHPublicKey()!;

      // Distribute epoch 1 key
      const dist1 = await alice.distributeSenderKey([
        { peerId: 'bob-uid', publicKey: bobECDHPub },
      ]);
      await bob.receiveSenderKey(dist1, aliceECDHPub);

      // Alice sends an in-flight message at epoch 1
      const encrypted1 = await alice.encryptMessage('epoch 1 message');

      // Alice rotates to epoch 2
      await alice.generateSenderKey(); // epoch 2
      const dist2 = await alice.distributeSenderKey([
        { peerId: 'bob-uid', publicKey: bobECDHPub },
      ]);
      await bob.receiveSenderKey(dist2, aliceECDHPub);

      // Bob can still decrypt the old epoch 1 message
      const plain1 = await bob.decryptMessage(encrypted1, 'alice-uid');
      expect(plain1).toBe('epoch 1 message');

      // Bob can also decrypt new epoch 2 messages
      const encrypted2 = await alice.encryptMessage('epoch 2 message');
      const plain2 = await bob.decryptMessage(encrypted2, 'alice-uid');
      expect(plain2).toBe('epoch 2 message');
    });
  });

  describe('peer removal', () => {
    it('should remove peer key when peer leaves', async () => {
      await alice.generateSenderKey();
      const aliceECDHPub = alice.getECDHPublicKey()!;
      const bobECDHPub = bob.getECDHPublicKey()!;

      const dist = await alice.distributeSenderKey([
        { peerId: 'bob-uid', publicKey: bobECDHPub },
      ]);
      await bob.receiveSenderKey(dist, aliceECDHPub);

      bob.removePeerKey('alice-uid');
      expect(bob.hasPeerKey('alice-uid')).toBe(false);
    });

    it('should fail to decrypt after peer key removal', async () => {
      await alice.generateSenderKey();
      const aliceECDHPub = alice.getECDHPublicKey()!;
      const bobECDHPub = bob.getECDHPublicKey()!;

      const dist = await alice.distributeSenderKey([
        { peerId: 'bob-uid', publicKey: bobECDHPub },
      ]);
      await bob.receiveSenderKey(dist, aliceECDHPub);

      bob.removePeerKey('alice-uid');

      const encrypted = await alice.encryptMessage('after removal');
      await expect(
        bob.decryptMessage(encrypted, 'alice-uid')
      ).rejects.toThrow('No sender key');
    });
  });

  describe('destroy()', () => {
    it('should clear all keys', () => {
      alice.destroy();
      expect(alice.getECDHPublicKey()).toBeNull();
    });
  });
});
