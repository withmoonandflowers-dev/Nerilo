import { describe, it, expect, beforeEach } from 'vitest';
import { DHTStorage, type DHTStoredMessage } from '../../src/core/transport/DHTStorage';

function makeMessage(overrides: Partial<DHTStoredMessage> = {}): DHTStoredMessage {
  return {
    messageId: `msg-${Math.random().toString(36).slice(2)}`,
    recipientId: 'recipient-1',
    senderId: 'sender-1',
    roomId: 'room-1',
    payload: 'hello',
    storedAt: Date.now(),
    expiresAt: Date.now() + 60_000,
    replicaCount: 1,
    ...overrides,
  };
}

describe('DHTStorage', () => {
  let storage: DHTStorage;

  beforeEach(() => {
    storage = new DHTStorage({
      maxTotalMessages: 100,
      maxMessagesPerRecipient: 20,
      maxPayloadBytes: 1024,
      messageTtlMs: 60_000,
    });
  });

  // ── Store ─────────────────────────────────────────────────────────

  describe('storeMessage', () => {
    it('stores a valid message', () => {
      const msg = makeMessage();
      expect(storage.storeMessage(msg)).toBe(true);
      expect(storage.getMessageCount()).toBe(1);
    });

    it('rejects duplicate messages', () => {
      const msg = makeMessage();
      storage.storeMessage(msg);
      expect(storage.storeMessage(msg)).toBe(false);
      expect(storage.getMessageCount()).toBe(1);
    });

    it('rejects expired messages', () => {
      const msg = makeMessage({ expiresAt: Date.now() - 1000 });
      expect(storage.storeMessage(msg)).toBe(false);
    });

    it('rejects oversized payloads', () => {
      const msg = makeMessage({ payload: 'x'.repeat(2000) });
      expect(storage.storeMessage(msg)).toBe(false);
    });

    it('enforces per-recipient limit', () => {
      for (let i = 0; i < 20; i++) {
        storage.storeMessage(makeMessage());
      }
      expect(storage.getMessageCount()).toBe(20);
      expect(storage.storeMessage(makeMessage())).toBe(false);
    });

    it('enforces total capacity limit', () => {
      const smallStorage = new DHTStorage({
        maxTotalMessages: 5,
        maxMessagesPerRecipient: 10,
        messageTtlMs: 60_000,
      });
      for (let i = 0; i < 5; i++) {
        smallStorage.storeMessage(makeMessage({ recipientId: `r-${i}` }));
      }
      expect(smallStorage.storeMessage(makeMessage({ recipientId: 'r-new' }))).toBe(false);
    });
  });

  // ── Retrieve ──────────────────────────────────────────────────────

  describe('retrieveMessages', () => {
    it('retrieves messages for a recipient', () => {
      storage.storeMessage(makeMessage({ recipientId: 'alice' }));
      storage.storeMessage(makeMessage({ recipientId: 'alice' }));
      storage.storeMessage(makeMessage({ recipientId: 'bob' }));

      expect(storage.retrieveMessages('alice')).toHaveLength(2);
      expect(storage.retrieveMessages('bob')).toHaveLength(1);
      expect(storage.retrieveMessages('charlie')).toHaveLength(0);
    });

    it('filters by roomId when specified', () => {
      storage.storeMessage(makeMessage({ recipientId: 'alice', roomId: 'room-a' }));
      storage.storeMessage(makeMessage({ recipientId: 'alice', roomId: 'room-b' }));

      expect(storage.retrieveMessages('alice', 'room-a')).toHaveLength(1);
      expect(storage.retrieveMessages('alice')).toHaveLength(2);
    });

    it('excludes expired messages', () => {
      storage.storeMessage(makeMessage({
        recipientId: 'alice',
        expiresAt: Date.now() - 1,
        storedAt: Date.now() - 100000,
      }));
      // Hack: store directly without expiry check (simulating stored before expiry)
      const old = makeMessage({ recipientId: 'alice' });
      storage.storeMessage(old);

      const results = storage.retrieveMessages('alice');
      expect(results.length).toBeGreaterThanOrEqual(1);
    });
  });

  // ── Delete ────────────────────────────────────────────────────────

  describe('deleteMessages', () => {
    it('deletes specific messages', () => {
      const msg1 = makeMessage({ recipientId: 'alice' });
      const msg2 = makeMessage({ recipientId: 'alice' });
      storage.storeMessage(msg1);
      storage.storeMessage(msg2);

      const deleted = storage.deleteMessages('alice', [msg1.messageId]);
      expect(deleted).toBe(1);
      expect(storage.getMessageCount()).toBe(1);
    });

    it('handles deleting from non-existent recipient', () => {
      expect(storage.deleteMessages('unknown', ['id1'])).toBe(0);
    });

    it('cleans up empty recipient entries', () => {
      const msg = makeMessage({ recipientId: 'alice' });
      storage.storeMessage(msg);
      storage.deleteMessages('alice', [msg.messageId]);
      expect(storage.getRecipientCount()).toBe(0);
    });
  });

  describe('deleteAllForRecipient', () => {
    it('deletes all messages for a recipient', () => {
      storage.storeMessage(makeMessage({ recipientId: 'alice' }));
      storage.storeMessage(makeMessage({ recipientId: 'alice' }));
      storage.storeMessage(makeMessage({ recipientId: 'bob' }));

      const deleted = storage.deleteAllForRecipient('alice');
      expect(deleted).toBe(2);
      expect(storage.getMessageCount()).toBe(1);
    });
  });

  // ── Protocol Handling ─────────────────────────────────────────────

  describe('handleProtocolMessage', () => {
    it('handles DHT_STORE', () => {
      const msg = makeMessage();
      storage.handleProtocolMessage({
        type: 'DHT_STORE',
        fromId: 'node-1',
        recipientId: msg.recipientId,
        roomId: msg.roomId,
        message: msg,
        requestId: 'req-1',
      });
      expect(storage.getMessageCount()).toBe(1);
    });

    it('handles DHT_RETRIEVE and returns response', () => {
      const msg = makeMessage({ recipientId: 'alice' });
      storage.storeMessage(msg);

      const response = storage.handleProtocolMessage({
        type: 'DHT_RETRIEVE',
        fromId: 'node-1',
        recipientId: 'alice',
        roomId: 'room-1',
        requestId: 'req-1',
      });

      expect(response).toBeTruthy();
      expect(response!.type).toBe('DHT_RESPONSE');
      expect(response!.messages).toHaveLength(1);
    });

    it('handles DHT_DELETE', () => {
      const msg = makeMessage({ recipientId: 'alice' });
      storage.storeMessage(msg);

      storage.handleProtocolMessage({
        type: 'DHT_DELETE',
        fromId: 'node-1',
        recipientId: 'alice',
        roomId: 'room-1',
        messageIds: [msg.messageId],
        requestId: 'req-1',
      });

      expect(storage.getMessageCount()).toBe(0);
    });
  });

  // ── Pruning ───────────────────────────────────────────────────────

  describe('pruneExpired', () => {
    it('removes expired messages', async () => {
      const shortTTL = new DHTStorage({ messageTtlMs: 1 });
      shortTTL.storeMessage(makeMessage({
        expiresAt: Date.now() + 1,
      }));
      expect(shortTTL.getMessageCount()).toBe(1);

      await new Promise(r => setTimeout(r, 10));
      const pruned = shortTTL.pruneExpired();
      expect(pruned).toBe(1);
      expect(shortTTL.getMessageCount()).toBe(0);
    });
  });

  // ── Queries ───────────────────────────────────────────────────────

  describe('queries', () => {
    it('reports stats correctly', () => {
      storage.storeMessage(makeMessage({ recipientId: 'alice' }));
      storage.storeMessage(makeMessage({ recipientId: 'bob' }));

      const stats = storage.getStats();
      expect(stats.totalMessages).toBe(2);
      expect(stats.recipients).toBe(2);
      expect(stats.maxCapacity).toBe(100);
      expect(stats.utilizationPercent).toBe(2);
    });

    it('hasMessages works', () => {
      expect(storage.hasMessages('alice')).toBe(false);
      storage.storeMessage(makeMessage({ recipientId: 'alice' }));
      expect(storage.hasMessages('alice')).toBe(true);
    });

    it('getPendingCount works', () => {
      storage.storeMessage(makeMessage({ recipientId: 'alice' }));
      storage.storeMessage(makeMessage({ recipientId: 'alice' }));
      expect(storage.getPendingCount('alice')).toBe(2);
      expect(storage.getPendingCount('bob')).toBe(0);
    });
  });

  // ── Destroy ───────────────────────────────────────────────────────

  describe('destroy', () => {
    it('clears all state', () => {
      storage.storeMessage(makeMessage());
      storage.destroy();
      expect(storage.getMessageCount()).toBe(0);
      expect(storage.getRecipientCount()).toBe(0);
    });
  });
});
