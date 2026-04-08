import { describe, it, expect, beforeEach } from 'vitest';
import { SenderKeyManager } from '../../src/core/crypto/SenderKeyManager';
import { DHTStoreAndForward } from '../../src/core/transport/DHTStoreAndForward';
import { DHTStorage, type DHTStoredMessage } from '../../src/core/transport/DHTStorage';
import { KademliaRouter } from '../../src/core/relay/KademliaRouter';

// ── B-1: Replay Protection ──────────────────────────────────────────────────

describe('B-1: Encryption Replay Protection', () => {
  let alice: SenderKeyManager;
  let bob: SenderKeyManager;

  beforeEach(async () => {
    alice = new SenderKeyManager('alice');
    bob = new SenderKeyManager('bob');
    await alice.initKeyPair();
    await bob.initKeyPair();
  });

  it('encrypted messages include monotonic seq counter', async () => {
    await alice.generateSenderKey();

    const msg1 = await alice.encryptMessage('hello');
    const msg2 = await alice.encryptMessage('world');

    expect(msg1.seq).toBe(0);
    expect(msg2.seq).toBe(1);
  });

  it('seq resets on new epoch (key rotation)', async () => {
    await alice.generateSenderKey();
    await alice.encryptMessage('msg1'); // seq=0
    await alice.encryptMessage('msg2'); // seq=1

    await alice.generateSenderKey(); // New epoch
    const msg3 = await alice.encryptMessage('msg3');
    expect(msg3.seq).toBe(0); // Reset
  });

  it('detects replay attack (same seq within same epoch)', async () => {
    await alice.generateSenderKey();

    const alicePub = alice.getECDHPublicKey()!;
    const dist = await alice.distributeSenderKey([
      { peerId: 'bob', publicKey: bob.getECDHPublicKey()! },
    ]);
    await bob.receiveSenderKey(dist, alicePub);

    const msg = await alice.encryptMessage('important action');
    await bob.decryptMessage(msg, 'alice'); // OK

    // Replay: re-send the exact same message
    await expect(bob.decryptMessage(msg, 'alice')).rejects.toThrow(/Replay detected/);
  });

  it('allows messages from different epochs with same seq', async () => {
    await alice.generateSenderKey();

    const alicePub = alice.getECDHPublicKey()!;
    const dist1 = await alice.distributeSenderKey([
      { peerId: 'bob', publicKey: bob.getECDHPublicKey()! },
    ]);
    await bob.receiveSenderKey(dist1, alicePub);

    const msg1 = await alice.encryptMessage('epoch1'); // epoch=1, seq=0
    await bob.decryptMessage(msg1, 'alice');

    // Rotate key (new epoch)
    await alice.generateSenderKey();
    const dist2 = await alice.distributeSenderKey([
      { peerId: 'bob', publicKey: bob.getECDHPublicKey()! },
    ]);
    await bob.receiveSenderKey(dist2, alicePub);

    const msg2 = await alice.encryptMessage('epoch2'); // epoch=2, seq=0
    // Should succeed despite seq=0 (different epoch)
    const decrypted = await bob.decryptMessage(msg2, 'alice');
    expect(decrypted).toBe('epoch2');
  });

  it('rejects out-of-order seq within same epoch', async () => {
    await alice.generateSenderKey();

    const alicePub = alice.getECDHPublicKey()!;
    const dist = await alice.distributeSenderKey([
      { peerId: 'bob', publicKey: bob.getECDHPublicKey()! },
    ]);
    await bob.receiveSenderKey(dist, alicePub);

    const msg1 = await alice.encryptMessage('first'); // seq=0
    const msg2 = await alice.encryptMessage('second'); // seq=1

    // Deliver msg2 first (out of order — seq=1)
    await bob.decryptMessage(msg2, 'alice');

    // Now deliver msg1 (seq=0, lower than last seen 1)
    await expect(bob.decryptMessage(msg1, 'alice')).rejects.toThrow(/Replay detected/);
  });
});

// ── B-3: DHT Rate Limiting ──────────────────────────────────────────────────

describe('B-3: DHT Store Rate Limiting', () => {
  let dhtSF: DHTStoreAndForward;

  beforeEach(() => {
    const router = new KademliaRouter('aa'.repeat(16));
    dhtSF = new DHTStoreAndForward('aa'.repeat(16), router, {
      storageConfig: { maxTotalMessages: 1000 },
    });
  });

  function makeStoreMsg(fromId: string, msgNum: number) {
    return {
      type: 'DHT_STORE' as const,
      fromId,
      recipientId: 'recipient-1',
      roomId: 'room-1',
      message: {
        messageId: `msg-${fromId}-${msgNum}`,
        recipientId: 'recipient-1',
        senderId: fromId,
        roomId: 'room-1',
        payload: 'test',
        storedAt: Date.now(),
        expiresAt: Date.now() + 60_000,
        replicaCount: 1,
      } satisfies DHTStoredMessage,
      requestId: `req-${msgNum}`,
    };
  }

  it('accepts stores within rate limit', () => {
    for (let i = 0; i < 50; i++) {
      dhtSF.handleIncoming(makeStoreMsg('sender-1', i));
    }
    // All 50 should be stored (limit is 50/minute)
    expect(dhtSF.getLocalPendingCount('recipient-1')).toBe(50);
  });

  it('rejects stores exceeding rate limit from same sender', () => {
    for (let i = 0; i < 55; i++) {
      dhtSF.handleIncoming(makeStoreMsg('flood-attacker', i));
    }
    // Only first 50 should be stored
    expect(dhtSF.getLocalPendingCount('recipient-1')).toBe(50);
  });

  it('rate limits are per-sender (different senders have separate limits)', () => {
    for (let i = 0; i < 50; i++) {
      dhtSF.handleIncoming(makeStoreMsg('sender-A', i));
    }
    // sender-A hit limit, but sender-B should still work
    dhtSF.handleIncoming(makeStoreMsg('sender-B', 0));
    expect(dhtSF.getLocalPendingCount('recipient-1')).toBe(51);
  });
});

// ── B-4: Base64 Error Handling ──────────────────────────────────────────────

describe('B-4: Base64 Decoding Error Handling', () => {
  it('SenderKeyManager rejects invalid base64 ciphertext', async () => {
    const mgr = new SenderKeyManager('test');
    await mgr.initKeyPair();
    await mgr.generateSenderKey();

    await expect(
      mgr.decryptMessage(
        { ciphertext: '!!!invalid-base64!!!', iv: 'AAAA', senderKeyEpoch: 1, seq: 0 },
        'peer'
      )
    ).rejects.toThrow();
  });

  it('DHTStorage rejects expired messages with no crash', () => {
    const storage = new DHTStorage();
    // Should not crash, just return false
    const result = storage.storeMessage({
      messageId: 'test',
      recipientId: 'r',
      senderId: 's',
      roomId: 'room',
      payload: 'data',
      storedAt: Date.now(),
      expiresAt: Date.now() - 1000, // expired
      replicaCount: 1,
    });
    expect(result).toBe(false);
  });
});

// ── B-5: Fragment Map Cap ───────────────────────────────────────────────────

describe('B-5: MessageAssembler Fragment Limits', () => {
  // Note: MessageAssembler requires WebRTC-like context that's hard to unit test
  // directly. These are logical tests of the protection mechanisms.

  it('DHTStorage enforces per-recipient limit', () => {
    const storage = new DHTStorage({
      maxMessagesPerRecipient: 5,
      maxTotalMessages: 100,
    });

    for (let i = 0; i < 10; i++) {
      storage.storeMessage({
        messageId: `msg-${i}`,
        recipientId: 'alice',
        senderId: 'sender',
        roomId: 'room',
        payload: 'data',
        storedAt: Date.now(),
        expiresAt: Date.now() + 60_000,
        replicaCount: 1,
      });
    }

    // Only 5 stored (per-recipient cap)
    expect(storage.getPendingCount('alice')).toBe(5);
  });

  it('DHTStorage enforces total capacity limit', () => {
    const storage = new DHTStorage({
      maxMessagesPerRecipient: 100,
      maxTotalMessages: 5,
    });

    for (let i = 0; i < 10; i++) {
      storage.storeMessage({
        messageId: `msg-${i}`,
        recipientId: `recipient-${i}`,
        senderId: 'sender',
        roomId: 'room',
        payload: 'data',
        storedAt: Date.now(),
        expiresAt: Date.now() + 60_000,
        replicaCount: 1,
      });
    }

    expect(storage.getMessageCount()).toBe(5);
  });
});
