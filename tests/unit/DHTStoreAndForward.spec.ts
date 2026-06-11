import { describe, it, expect, beforeEach } from 'vitest';
import { DHTStoreAndForward } from '../../src/core/transport/DHTStoreAndForward';
import { KademliaRouter } from '../../src/core/relay/KademliaRouter';
import type { DHTProtocolMessage } from '../../src/core/transport/DHTStorage';

describe('DHTStoreAndForward', () => {
  let router: KademliaRouter;
  let dhtSF: DHTStoreAndForward;
  let sentMessages: Array<{ targetNodeId: string; message: DHTProtocolMessage }>;

  beforeEach(() => {
    router = new KademliaRouter('aa'.repeat(16)); // 256-bit local ID
    dhtSF = new DHTStoreAndForward('aa'.repeat(16), router, {
      minDHTNodes: 2,
      storageConfig: {
        maxTotalMessages: 100,
        messageTtlMs: 60_000,
      },
    });

    sentMessages = [];
    dhtSF.setSendFunction((targetNodeId, message) => {
      sentMessages.push({ targetNodeId, message });
    });

    // Add some DHT nodes
    router.addNode({
      nodeId: 'bb'.repeat(16),
      lastSeen: Date.now(),
      latency: 50,
      isRelayCapable: true,
      natType: 'open',
    });
    router.addNode({
      nodeId: 'cc'.repeat(16),
      lastSeen: Date.now(),
      latency: 100,
      isRelayCapable: true,
      natType: 'full-cone',
    });
    router.addNode({
      nodeId: 'dd'.repeat(16),
      lastSeen: Date.now(),
      latency: 150,
      isRelayCapable: true,
      natType: 'open',
    });
  });

  // ── Store ─────────────────────────────────────────────────────────

  describe('store', () => {
    it('stores locally and sends to DHT nodes', () => {
      const { messageId, replicasSent } = dhtSF.store(
        'room-1',
        'recipient-1',
        'sender-1',
        'hello offline'
      );

      expect(messageId).toBeTruthy();
      expect(replicasSent).toBeGreaterThan(0);
      // Should send DHT_STORE to remote nodes
      expect(sentMessages.length).toBeGreaterThan(0);
      expect(sentMessages[0]!.message.type).toBe('DHT_STORE');
    });

    it('stores locally even without send function', () => {
      dhtSF.setSendFunction(null as unknown as (t: string, m: DHTProtocolMessage) => void);
      // Actually we need a different approach - let's create one without sendFn
      const dht2 = new DHTStoreAndForward('aa'.repeat(16), router);
      const { replicasSent } = dht2.store('room-1', 'r-1', 's-1', 'test');
      expect(replicasSent).toBe(1); // local only
      dht2.destroy();
    });

    it('includes message data in DHT_STORE', () => {
      dhtSF.store('room-1', 'recipient-1', 'sender-1', 'payload data');

      const storeMsg = sentMessages.find(m => m.message.type === 'DHT_STORE');
      expect(storeMsg).toBeTruthy();
      expect(storeMsg!.message.message).toBeTruthy();
      expect(storeMsg!.message.message!.payload).toBe('payload data');
      expect(storeMsg!.message.message!.recipientId).toBe('recipient-1');
    });
  });

  // ── Retrieve ──────────────────────────────────────────────────────

  describe('retrieve', () => {
    it('retrieves locally stored messages', () => {
      dhtSF.store('room-1', 'recipient-1', 'sender-1', 'msg1');
      dhtSF.store('room-1', 'recipient-1', 'sender-2', 'msg2');

      const delivered: Array<{ from: string; payload: string }> = [];
      const { localMessages } = dhtSF.retrieve('room-1', 'recipient-1', (from, payload) => {
        delivered.push({ from, payload });
      });

      expect(localMessages).toBe(2);
      expect(delivered).toHaveLength(2);
    });

    it('sends DHT_RETRIEVE to remote nodes', () => {
      sentMessages.length = 0;
      dhtSF.retrieve('room-1', 'recipient-1', () => {});

      const retrieveMsgs = sentMessages.filter(m => m.message.type === 'DHT_RETRIEVE');
      expect(retrieveMsgs.length).toBeGreaterThan(0);
    });

    it('deletes local messages after delivery', () => {
      dhtSF.store('room-1', 'recipient-1', 'sender-1', 'msg1');
      expect(dhtSF.getLocalPendingCount('recipient-1')).toBe(1);

      dhtSF.retrieve('room-1', 'recipient-1', () => {});
      expect(dhtSF.getLocalPendingCount('recipient-1')).toBe(0);
    });
  });

  // ── Drain Local ───────────────────────────────────────────────────

  describe('drainLocal', () => {
    it('drains all local messages', () => {
      dhtSF.store('room-1', 'r-1', 's-1', 'a');
      dhtSF.store('room-1', 'r-1', 's-2', 'b');

      const delivered: string[] = [];
      const consumed = dhtSF.drainLocal('room-1', 'r-1', (_from, payload) => {
        delivered.push(payload);
      });

      expect(consumed).toBe(2);
      expect(delivered).toEqual(['a', 'b']);
      expect(dhtSF.getLocalMessageCount()).toBe(0);
    });
  });

  // ── Protocol Handling ─────────────────────────────────────────────

  describe('handleIncoming', () => {
    it('handles DHT_STORE from remote', () => {
      dhtSF.handleIncoming({
        type: 'DHT_STORE',
        fromId: 'bb'.repeat(16),
        recipientId: 'recipient-1',
        roomId: 'room-1',
        message: {
          messageId: 'remote-msg-1',
          recipientId: 'recipient-1',
          senderId: 'sender-1',
          roomId: 'room-1',
          payload: 'remote hello',
          storedAt: Date.now(),
          expiresAt: Date.now() + 60_000,
          replicaCount: 3,
        },
        requestId: 'req-1',
      });

      expect(dhtSF.getLocalPendingCount('recipient-1')).toBe(1);
    });

    it('handles DHT_RETRIEVE and sends response', () => {
      // Store a message first
      dhtSF.store('room-1', 'alice', 'bob', 'stored msg');
      sentMessages.length = 0;

      // Simulate remote RETRIEVE request
      dhtSF.handleIncoming({
        type: 'DHT_RETRIEVE',
        fromId: 'bb'.repeat(16),
        recipientId: 'alice',
        roomId: 'room-1',
        requestId: 'req-retrieve',
      });

      // Should send DHT_RESPONSE back
      const responses = sentMessages.filter(m => m.message.type === 'DHT_RESPONSE');
      expect(responses).toHaveLength(1);
      expect(responses[0]!.message.messages!.length).toBeGreaterThan(0);
      expect(responses[0]!.targetNodeId).toBe('bb'.repeat(16));
    });

    it('handles DHT_DELETE from remote', () => {
      dhtSF.store('room-1', 'alice', 'bob', 'to delete');
      const messages = dhtSF['localStorage'].retrieveMessages('alice');
      const msgId = messages[0]!.messageId;

      dhtSF.handleIncoming({
        type: 'DHT_DELETE',
        fromId: 'bb'.repeat(16),
        recipientId: 'alice',
        roomId: 'room-1',
        messageIds: [msgId],
        requestId: 'req-del',
      });

      expect(dhtSF.getLocalPendingCount('alice')).toBe(0);
    });

    it('handles DHT_RESPONSE and delivers to handler', () => {
      // Start a retrieve to set up pending handler
      const delivered: Array<{ from: string; payload: string }> = [];
      dhtSF.retrieve('room-1', 'target-1', (from, payload) => {
        delivered.push({ from, payload });
      });

      // Get the requestId from the sent retrieve messages
      const retrieveMsg = sentMessages.find(m => m.message.type === 'DHT_RETRIEVE');
      expect(retrieveMsg).toBeTruthy();
      const requestId = retrieveMsg!.message.requestId;

      // Simulate response from all remote nodes
      const remoteNodes = sentMessages.filter(m => m.message.type === 'DHT_RETRIEVE');
      for (const rm of remoteNodes) {
        dhtSF.handleIncoming({
          type: 'DHT_RESPONSE',
          fromId: rm.targetNodeId,
          recipientId: 'target-1',
          roomId: 'room-1',
          messages: [{
            messageId: `remote-${rm.targetNodeId}`,
            recipientId: 'target-1',
            senderId: 'sender-remote',
            roomId: 'room-1',
            payload: `msg from ${rm.targetNodeId.slice(0, 4)}`,
            storedAt: Date.now(),
            expiresAt: Date.now() + 60_000,
            replicaCount: 1,
          }],
          requestId,
        });
      }

      // Messages should be delivered (deduped)
      expect(delivered.length).toBeGreaterThan(0);
    });
  });

  // ── Sufficient Nodes Check ────────────────────────────────────────

  describe('hasSufficientNodes', () => {
    it('returns true when enough DHT nodes', () => {
      expect(dhtSF.hasSufficientNodes()).toBe(true); // 3 nodes >= minDHTNodes(2)
    });

    it('returns false when insufficient nodes', () => {
      const emptyRouter = new KademliaRouter('ff'.repeat(16));
      const dht2 = new DHTStoreAndForward('ff'.repeat(16), emptyRouter, { minDHTNodes: 3 });
      expect(dht2.hasSufficientNodes()).toBe(false);
      dht2.destroy();
    });
  });

  // ── Stats ─────────────────────────────────────────────────────────

  describe('getStats', () => {
    it('reports comprehensive stats', () => {
      dhtSF.store('room-1', 'r-1', 's-1', 'test');

      const stats = dhtSF.getStats();
      expect(stats.totalMessages).toBe(1);
      expect(stats.dhtNodeCount).toBe(3);
      expect(stats.hasSufficientNodes).toBe(true);
    });
  });

  // ── Cleanup ───────────────────────────────────────────────────────

  describe('pruneExpired', () => {
    it('removes expired messages', async () => {
      const shortTTL = new DHTStoreAndForward('aa'.repeat(16), router, {
        storageConfig: { messageTtlMs: 100 },
      });

      shortTTL.store('room-1', 'r-1', 's-1', 'expires soon');
      await new Promise(r => setTimeout(r, 200));

      const pruned = shortTTL.pruneExpired();
      expect(pruned).toBe(1);
      shortTTL.destroy();
    });
  });

  // ── Destroy ───────────────────────────────────────────────────────

  describe('destroy', () => {
    it('cleans up all state', () => {
      dhtSF.store('room-1', 'r-1', 's-1', 'test');
      dhtSF.destroy();
      expect(dhtSF.getLocalMessageCount()).toBe(0);
    });
  });
});
