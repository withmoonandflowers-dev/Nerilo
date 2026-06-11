import { describe, it, expect, beforeEach } from 'vitest';
import { TreeKEMManager } from '../../src/core/crypto/TreeKEMManager';

describe('TreeKEMManager', () => {
  // ── Static Tree Geometry ────────────────────────────────────────────

  describe('treeNodeCount', () => {
    it('returns 0 for empty tree', () => {
      expect(TreeKEMManager.treeNodeCount(0)).toBe(0);
    });

    it('returns 1 for single member', () => {
      expect(TreeKEMManager.treeNodeCount(1)).toBe(1);
    });

    it('returns 3 for 2 members', () => {
      expect(TreeKEMManager.treeNodeCount(2)).toBe(3);
    });

    it('returns 7 for 4 members', () => {
      expect(TreeKEMManager.treeNodeCount(4)).toBe(7);
    });

    it('returns 199 for 100 members', () => {
      expect(TreeKEMManager.treeNodeCount(100)).toBe(199);
    });
  });

  describe('leafNodeIndex', () => {
    it('returns 0 for single member', () => {
      expect(TreeKEMManager.leafNodeIndex(0, 1)).toBe(0);
    });

    it('maps leaves to bottom of binary tree', () => {
      // 4 leaves in tree of 7: leaf indices should be 3, 4, 5, 6
      expect(TreeKEMManager.leafNodeIndex(0, 4)).toBe(3);
      expect(TreeKEMManager.leafNodeIndex(1, 4)).toBe(4);
      expect(TreeKEMManager.leafNodeIndex(2, 4)).toBe(5);
      expect(TreeKEMManager.leafNodeIndex(3, 4)).toBe(6);
    });
  });

  describe('treeDepth', () => {
    it('returns 0 for single member', () => {
      expect(TreeKEMManager.treeDepth(1)).toBe(0);
    });

    it('returns 1 for 2 members', () => {
      expect(TreeKEMManager.treeDepth(2)).toBe(1);
    });

    it('returns 7 for 100 members (ceil(log2(100)))', () => {
      expect(TreeKEMManager.treeDepth(100)).toBe(7);
    });
  });

  // ── Initialization & Key Generation ───────────────────────────────

  describe('initialization', () => {
    let alice: TreeKEMManager;

    beforeEach(() => {
      alice = new TreeKEMManager('alice');
    });

    it('initializes ECDH key pair', async () => {
      const pubKey = await alice.initKeyPair();
      expect(pubKey).toBeTruthy();
      expect(alice.getECDHPublicKey()).toBe(pubKey);
    });

    it('starts at epoch 0', () => {
      expect(alice.epoch).toBe(0);
    });

    it('starts with no group secret', () => {
      expect(alice.hasGroupSecret()).toBe(false);
    });
  });

  // ── Tree Building ─────────────────────────────────────────────────

  describe('buildTree', () => {
    it('builds a tree and produces an update', async () => {
      const alice = new TreeKEMManager('alice');
      await alice.initKeyPair();

      const bobKP = await generateECDHKeyPair();

      const update = await alice.buildTree([
        { peerId: 'bob', publicKey: bobKP.publicKey },
      ]);

      expect(update.senderId).toBe('alice');
      expect(update.epoch).toBe(1);
      expect(update.pathPublicKeys.length).toBeGreaterThan(0);
      expect(alice.hasGroupSecret()).toBe(true);
      expect(alice.memberCount).toBe(2);
    });

    it('builds a tree with multiple members', async () => {
      const alice = new TreeKEMManager('alice');
      await alice.initKeyPair();

      const members = await createMembers(4);
      const update = await alice.buildTree(members);

      expect(update.epoch).toBe(1);
      expect(alice.memberCount).toBe(5); // alice + 4 others
      expect(alice.hasGroupSecret()).toBe(true);
    });

    it('single member tree works', async () => {
      const alice = new TreeKEMManager('alice');
      await alice.initKeyPair();

      const update = await alice.buildTree([]);
      expect(update.epoch).toBe(1);
      expect(alice.memberCount).toBe(1);
      expect(alice.hasGroupSecret()).toBe(true);
    });
  });

  // ── Encryption / Decryption ───────────────────────────────────────

  describe('encrypt / decrypt', () => {
    it('encrypts and decrypts with group secret', async () => {
      const alice = new TreeKEMManager('alice');
      await alice.initKeyPair();
      await alice.buildTree([]);

      const encrypted = await alice.encryptMessage('hello world');
      expect(encrypted.ciphertext).toBeTruthy();
      expect(encrypted.iv).toBeTruthy();
      expect(encrypted.senderKeyEpoch).toBe(1);

      const decrypted = await alice.decryptMessage(encrypted);
      expect(decrypted).toBe('hello world');
    });

    it('throws when encrypting without group secret', async () => {
      const alice = new TreeKEMManager('alice');
      await alice.initKeyPair();

      await expect(alice.encryptMessage('test')).rejects.toThrow('Group secret not initialized');
    });

    it('tracks message count for auto-rotation', async () => {
      const alice = new TreeKEMManager('alice');
      await alice.initKeyPair();
      await alice.buildTree([]);

      expect(alice.getMessagesSinceRotation()).toBe(0);
      await alice.encryptMessage('msg1');
      expect(alice.getMessagesSinceRotation()).toBe(1);
      await alice.encryptMessage('msg2');
      expect(alice.getMessagesSinceRotation()).toBe(2);
    });
  });

  // ── Path Update (Key Rotation) ────────────────────────────────────

  describe('updatePath', () => {
    it('increments epoch on rotation', async () => {
      const alice = new TreeKEMManager('alice');
      await alice.initKeyPair();
      await alice.buildTree([]);

      expect(alice.epoch).toBe(1);
      await alice.forceRotation();
      expect(alice.epoch).toBe(2);
    });

    it('resets message counter on rotation', async () => {
      const alice = new TreeKEMManager('alice');
      await alice.initKeyPair();
      await alice.buildTree([]);

      await alice.encryptMessage('msg1');
      await alice.encryptMessage('msg2');
      expect(alice.getMessagesSinceRotation()).toBe(2);

      await alice.forceRotation();
      expect(alice.getMessagesSinceRotation()).toBe(0);
    });
  });

  // ── Auto-Rotation ─────────────────────────────────────────────────

  describe('checkAutoRotation', () => {
    it('returns null when thresholds not met', async () => {
      const alice = new TreeKEMManager('alice');
      await alice.initKeyPair();
      await alice.buildTree([]);

      const result = await alice.checkAutoRotation();
      expect(result).toBeNull();
    });

    it('triggers rotation when message threshold met', async () => {
      const alice = new TreeKEMManager('alice');
      await alice.initKeyPair();
      await alice.buildTree([]);
      alice.configureAutoRotation(3, 9999999);

      await alice.encryptMessage('1');
      await alice.encryptMessage('2');
      await alice.encryptMessage('3');

      const update = await alice.checkAutoRotation();
      expect(update).toBeTruthy();
      expect(update!.epoch).toBe(2);
    });
  });

  // ── Member Management ─────────────────────────────────────────────

  describe('addMember / removeMember', () => {
    it('adds a member and rebuilds tree', async () => {
      const alice = new TreeKEMManager('alice');
      await alice.initKeyPair();

      const bobKP = await generateECDHKeyPair();
      await alice.buildTree([{ peerId: 'bob', publicKey: bobKP.publicKey }]);
      expect(alice.memberCount).toBe(2);

      const charlieKP = await generateECDHKeyPair();
      const update = await alice.addMember('charlie', charlieKP.publicKey);
      expect(alice.memberCount).toBe(3);
      expect(update.epoch).toBeGreaterThan(0);
    });

    it('removes a member and rebuilds tree', async () => {
      const alice = new TreeKEMManager('alice');
      await alice.initKeyPair();

      const bobKP = await generateECDHKeyPair();
      const charlieKP = await generateECDHKeyPair();
      await alice.buildTree([
        { peerId: 'bob', publicKey: bobKP.publicKey },
        { peerId: 'charlie', publicKey: charlieKP.publicKey },
      ]);
      expect(alice.memberCount).toBe(3);

      const update = await alice.removeMember('bob');
      expect(alice.memberCount).toBe(2);
      expect(update.epoch).toBeGreaterThan(0);
      expect(alice.getMemberIds()).not.toContain('bob');
    });
  });

  // ── Destroy ───────────────────────────────────────────────────────

  describe('destroy', () => {
    it('clears all state', async () => {
      const alice = new TreeKEMManager('alice');
      await alice.initKeyPair();
      await alice.buildTree([]);

      alice.destroy();
      expect(alice.hasGroupSecret()).toBe(false);
      expect(alice.memberCount).toBe(0);
      expect(alice.epoch).toBe(0);
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
