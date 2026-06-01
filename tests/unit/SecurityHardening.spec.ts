/**
 * Security-hardening tests cherry-picked from PR #5 commit 3ac26e3.
 *
 * Only the SenderKeyManager-replay-protection and base64-error-handling
 * portions are kept here — the original commit also covered DHT rate-
 * limiting (DHTStoreAndForward) and DHT capacity caps (DHTStorage), but
 * those modules aren't on master yet. They'll come back when DHT lands.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { SenderKeyManager } from '../../src/core/crypto/SenderKeyManager';

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

// ── B-4: Base64 Error Handling ──────────────────────────────────────────────

describe('B-4: Base64 Decoding Error Handling', () => {
  it('SenderKeyManager rejects invalid base64 ciphertext', async () => {
    const mgr = new SenderKeyManager('test');
    await mgr.initKeyPair();
    await mgr.generateSenderKey();

    await expect(
      mgr.decryptMessage(
        { ciphertext: '!!!invalid-base64!!!', iv: 'AAAA', senderKeyEpoch: 1, seq: 0 },
        'peer',
      ),
    ).rejects.toThrow();
  });
});
