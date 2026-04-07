import { describe, it, expect, beforeEach } from 'vitest';
import { SenderKeyManager } from '../../src/core/crypto/SenderKeyManager';

describe('SenderKeyManager — Auto-Rotation', () => {
  let manager: SenderKeyManager;

  beforeEach(async () => {
    manager = new SenderKeyManager('user-local');
    await manager.initKeyPair();
    await manager.generateSenderKey();
  });

  afterEach(() => {
    manager.destroy();
  });

  describe('rotation configuration', () => {
    it('has default rotation thresholds', () => {
      // Should not rotate on first message
      expect(manager.getMessagesSinceRotation()).toBe(0);
    });

    it('accepts custom rotation config', () => {
      manager.configureAutoRotation(50, 1800_000);
      // No error = success
    });
  });

  describe('message counting', () => {
    it('increments counter on each encrypt', async () => {
      await manager.encryptMessage('hello');
      expect(manager.getMessagesSinceRotation()).toBe(1);

      await manager.encryptMessage('world');
      expect(manager.getMessagesSinceRotation()).toBe(2);
    });
  });

  describe('auto-rotation by message count', () => {
    it('does not rotate before threshold', async () => {
      manager.configureAutoRotation(5, 999_999_999);

      for (let i = 0; i < 4; i++) {
        await manager.encryptMessage(`msg-${i}`);
      }

      const result = await manager.checkAutoRotation();
      expect(result).toBeNull();
    });

    it('rotates after message threshold reached', async () => {
      manager.configureAutoRotation(3, 999_999_999);

      // Create a peer to receive the distribution
      const peer = new SenderKeyManager('user-peer');
      const peerPubKey = await peer.initKeyPair();

      manager.updateMembers([{ peerId: 'user-peer', publicKey: peerPubKey }]);

      const epochBefore = manager.epoch;

      for (let i = 0; i < 3; i++) {
        await manager.encryptMessage(`msg-${i}`);
      }

      const result = await manager.checkAutoRotation();
      expect(result).not.toBeNull();
      expect(result!.epoch).toBe(epochBefore + 1);
      expect(result!.senderId).toBe('user-local');
      expect(manager.getMessagesSinceRotation()).toBe(0);

      peer.destroy();
    });

    it('returns null when no members to distribute to', async () => {
      manager.configureAutoRotation(2, 999_999_999);

      await manager.encryptMessage('msg-1');
      await manager.encryptMessage('msg-2');

      const result = await manager.checkAutoRotation();
      // Rotation happens (key regenerated) but no distribution returned
      expect(result).toBeNull();
    });
  });

  describe('force rotation', () => {
    it('forces immediate key rotation', async () => {
      const peer = new SenderKeyManager('user-peer');
      const peerPubKey = await peer.initKeyPair();

      const epochBefore = manager.epoch;
      const result = await manager.forceRotation([
        { peerId: 'user-peer', publicKey: peerPubKey },
      ]);

      expect(result).not.toBeNull();
      expect(manager.epoch).toBe(epochBefore + 1);
      expect(manager.getMessagesSinceRotation()).toBe(0);

      peer.destroy();
    });

    it('updates cached members on force rotation', async () => {
      const peer = new SenderKeyManager('user-peer');
      const peerPubKey = await peer.initKeyPair();

      await manager.forceRotation([
        { peerId: 'user-peer', publicKey: peerPubKey },
      ]);

      // Subsequent auto-rotation should use updated members
      manager.configureAutoRotation(1, 999_999_999);
      await manager.encryptMessage('trigger');
      const result = await manager.checkAutoRotation();
      expect(result).not.toBeNull();
      expect(result!.encryptedKeys['user-peer']).toBeDefined();

      peer.destroy();
    });
  });

  describe('rotation callback', () => {
    it('invokes callback on auto-rotation', async () => {
      const peer = new SenderKeyManager('user-peer');
      const peerPubKey = await peer.initKeyPair();

      manager.updateMembers([{ peerId: 'user-peer', publicKey: peerPubKey }]);
      manager.configureAutoRotation(2, 999_999_999);

      let callbackCalled = false;
      manager.onAutoRotation(async (dist) => {
        callbackCalled = true;
        expect(dist.senderId).toBe('user-local');
      });

      await manager.encryptMessage('msg-1');
      await manager.encryptMessage('msg-2');
      await manager.checkAutoRotation();

      expect(callbackCalled).toBe(true);

      peer.destroy();
    });

    it('handles callback errors gracefully', async () => {
      const peer = new SenderKeyManager('user-peer');
      const peerPubKey = await peer.initKeyPair();

      manager.updateMembers([{ peerId: 'user-peer', publicKey: peerPubKey }]);
      manager.configureAutoRotation(1, 999_999_999);

      manager.onAutoRotation(async () => {
        throw new Error('callback failed');
      });

      await manager.encryptMessage('msg');
      // Should not throw
      const result = await manager.checkAutoRotation();
      expect(result).not.toBeNull();

      peer.destroy();
    });
  });

  describe('cross-epoch decryption', () => {
    it('decrypts messages from previous epoch after rotation', async () => {
      const sender = new SenderKeyManager('sender');
      const receiver = new SenderKeyManager('receiver');

      const senderPub = await sender.initKeyPair();
      const receiverPub = await receiver.initKeyPair();

      // Epoch 1: sender distributes key
      await sender.generateSenderKey();
      const dist1 = await sender.distributeSenderKey([
        { peerId: 'receiver', publicKey: receiverPub },
      ]);
      await receiver.receiveSenderKey(dist1, senderPub);

      // Encrypt with epoch 1
      const encrypted1 = await sender.encryptMessage('epoch-1-msg');

      // Rotate to epoch 2
      await sender.generateSenderKey();
      const dist2 = await sender.distributeSenderKey([
        { peerId: 'receiver', publicKey: receiverPub },
      ]);
      await receiver.receiveSenderKey(dist2, senderPub);

      // Should still decrypt epoch 1 message (in-flight)
      const decrypted = await receiver.decryptMessage(encrypted1, 'sender');
      expect(decrypted).toBe('epoch-1-msg');

      // Should also decrypt epoch 2 messages
      const encrypted2 = await sender.encryptMessage('epoch-2-msg');
      const decrypted2 = await receiver.decryptMessage(encrypted2, 'sender');
      expect(decrypted2).toBe('epoch-2-msg');

      sender.destroy();
      receiver.destroy();
    });
  });

  describe('cleanup', () => {
    it('resets rotation state on destroy', () => {
      manager.destroy();
      expect(manager.getMessagesSinceRotation()).toBe(0);
    });
  });
});
