import { describe, it, expect, beforeEach } from 'vitest';
import { GroupKeyManager } from '../../src/core/crypto/GroupKeyManager';

describe('GroupKeyManager', () => {
  let gkm: GroupKeyManager;

  beforeEach(async () => {
    gkm = new GroupKeyManager('alice', {
      treeKEMThreshold: 5, // low threshold for testing
    });
    await gkm.init();
  });

  // ── Initialization ────────────────────────────────────────────────

  describe('initialization', () => {
    it('initializes and reports correct state', () => {
      expect(gkm.isInitialized()).toBe(true);
      expect(gkm.getStrategy()).toBe('sender-key'); // default
      expect(gkm.getEpoch()).toBe(0);
    });

    it('throws if setupGroup called before init', async () => {
      const fresh = new GroupKeyManager('bob');
      await expect(fresh.setupGroup([])).rejects.toThrow('Call init() first');
    });
  });

  // ── Strategy Selection ────────────────────────────────────────────

  describe('strategy selection', () => {
    it('uses sender-key for small groups', async () => {
      const members = await createMembers(3);
      await gkm.setupGroup(members);

      expect(gkm.getStrategy()).toBe('sender-key');
      expect(gkm.getMemberCount()).toBe(4); // 3 + self
    });

    it('switches to tree-kem when crossing threshold', async () => {
      // Threshold is 5 total members; 3 members + self = 4 (below)
      const members = await createMembers(3);
      await gkm.setupGroup(members);
      expect(gkm.getStrategy()).toBe('sender-key'); // 4 total, below threshold

      // Add two more to reach 6 (above threshold of 5)
      const extra1 = await generateECDHKeyPair();
      await gkm.addMember('extra1', extra1.publicKey);
      // 5 total = at threshold, triggers switch
      expect(gkm.getStrategy()).toBe('tree-kem');
      expect(gkm.getMemberCount()).toBe(5);
    });

    it('starts with tree-kem for large initial groups', async () => {
      const members = await createMembers(5);
      await gkm.setupGroup(members);

      // 6 total members > threshold of 5
      expect(gkm.getStrategy()).toBe('tree-kem');
    });

    it('has hysteresis: does not switch back immediately', async () => {
      // Start with tree-kem (6 members, threshold 5)
      const members = await createMembers(5);
      await gkm.setupGroup(members);
      expect(gkm.getStrategy()).toBe('tree-kem');

      // Remove one — still above hysteresis band (threshold - 10 = -5, clamped)
      await gkm.removeMember('member-0');
      expect(gkm.getStrategy()).toBe('tree-kem'); // stays tree-kem due to hysteresis
    });
  });

  // ── Encryption / Decryption with SenderKey ────────────────────────

  describe('sender-key encryption', () => {
    it('encrypts and distributes keys for small group', async () => {
      const bobKP = await generateECDHKeyPair();
      const dist = await gkm.setupGroup([
        { peerId: 'bob', publicKey: bobKP.publicKey },
      ]);

      expect(dist).toBeTruthy();
      expect(gkm.getStrategy()).toBe('sender-key');
      expect(gkm.getEpoch()).toBe(1);
    });

    it('encrypts messages in sender-key mode', async () => {
      const bobKP = await generateECDHKeyPair();
      await gkm.setupGroup([
        { peerId: 'bob', publicKey: bobKP.publicKey },
      ]);

      const encrypted = await gkm.encryptMessage('hello');
      expect(encrypted.ciphertext).toBeTruthy();
      expect(encrypted.iv).toBeTruthy();
      expect(encrypted.senderKeyEpoch).toBe(1);
    });
  });

  // ── Encryption / Decryption with TreeKEM ──────────────────────────

  describe('tree-kem encryption', () => {
    it('encrypts and decrypts in tree-kem mode', async () => {
      const members = await createMembers(5);
      await gkm.setupGroup(members);
      expect(gkm.getStrategy()).toBe('tree-kem');

      const encrypted = await gkm.encryptMessage('hello tree-kem');
      expect(encrypted.ciphertext).toBeTruthy();

      const decrypted = await gkm.decryptMessage(encrypted, 'alice');
      expect(decrypted).toBe('hello tree-kem');
    });
  });

  // ── Member Management ─────────────────────────────────────────────

  describe('addMember / removeMember', () => {
    it('adds member in sender-key mode', async () => {
      const bobKP = await generateECDHKeyPair();
      await gkm.setupGroup([{ peerId: 'bob', publicKey: bobKP.publicKey }]);

      const charlieKP = await generateECDHKeyPair();
      const dist = await gkm.addMember('charlie', charlieKP.publicKey);
      expect(dist).toBeTruthy();
      expect(gkm.getMemberCount()).toBe(3);
    });

    it('removes member in sender-key mode', async () => {
      const bobKP = await generateECDHKeyPair();
      const charlieKP = await generateECDHKeyPair();
      await gkm.setupGroup([
        { peerId: 'bob', publicKey: bobKP.publicKey },
        { peerId: 'charlie', publicKey: charlieKP.publicKey },
      ]);

      await gkm.removeMember('bob');
      expect(gkm.getMemberCount()).toBe(2);
    });

    it('adds member in tree-kem mode', async () => {
      const members = await createMembers(5);
      await gkm.setupGroup(members);
      expect(gkm.getStrategy()).toBe('tree-kem');

      const newKP = await generateECDHKeyPair();
      await gkm.addMember('new-member', newKP.publicKey);
      expect(gkm.getMemberCount()).toBe(7);
    });
  });

  // ── Auto-Rotation ─────────────────────────────────────────────────

  describe('auto-rotation', () => {
    it('returns null when thresholds not met (sender-key)', async () => {
      const bobKP = await generateECDHKeyPair();
      await gkm.setupGroup([{ peerId: 'bob', publicKey: bobKP.publicKey }]);

      const result = await gkm.checkAutoRotation();
      expect(result).toBeNull();
    });

    it('force rotation works in sender-key mode', async () => {
      const bobKP = await generateECDHKeyPair();
      await gkm.setupGroup([{ peerId: 'bob', publicKey: bobKP.publicKey }]);

      const result = await gkm.forceRotation();
      expect(result).toBeTruthy();
      expect(gkm.getEpoch()).toBe(2);
    });

    it('force rotation works in tree-kem mode', async () => {
      const members = await createMembers(5);
      await gkm.setupGroup(members);
      expect(gkm.getStrategy()).toBe('tree-kem');

      const result = await gkm.forceRotation();
      expect(result).toBeTruthy();
      expect(gkm.getEpoch()).toBe(2);
    });
  });

  // ── Configuration ─────────────────────────────────────────────────

  describe('configuration', () => {
    it('reports threshold', () => {
      expect(gkm.getThreshold()).toBe(5);
    });

    it('tracks message count', async () => {
      const members = await createMembers(5);
      await gkm.setupGroup(members);

      expect(gkm.getMessagesSinceRotation()).toBe(0);
      await gkm.encryptMessage('msg');
      expect(gkm.getMessagesSinceRotation()).toBe(1);
    });
  });

  // ── Destroy ───────────────────────────────────────────────────────

  describe('destroy', () => {
    it('clears all state', async () => {
      const bobKP = await generateECDHKeyPair();
      await gkm.setupGroup([{ peerId: 'bob', publicKey: bobKP.publicKey }]);

      gkm.destroy();
      expect(gkm.isInitialized()).toBe(false);
      expect(gkm.getMemberCount()).toBe(1); // only self
    });
  });
});

// ── Helpers ─────────────────────────────────────────────────────────────────

async function generateECDHKeyPair(): Promise<CryptoKeyPair> {
  return crypto.subtle.generateKey(
    { name: 'ECDH', namedCurve: 'P-256' },
    true,
    ['deriveKey', 'deriveBits']
  );
}

async function createMembers(count: number) {
  const members: Array<{ peerId: string; publicKey: CryptoKey }> = [];
  for (let i = 0; i < count; i++) {
    const kp = await generateECDHKeyPair();
    members.push({ peerId: `member-${i}`, publicKey: kp.publicKey });
  }
  return members;
}
