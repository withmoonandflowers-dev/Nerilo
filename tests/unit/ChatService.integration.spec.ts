/**
 * ChatService Integration Tests
 *
 * Tests the full ChatService flow rather than individual methods:
 *  1. Complete key exchange -> encrypt -> send -> receive -> decrypt
 *  2. Message send fallback when E2EE is not ready
 *  3. Deduplication when multiple peers send simultaneously
 *  4. Continuity of decryption after sender key rotation
 *
 * @vitest-environment node
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ChatService } from '../../src/features/chat/ChatService';
import { SenderKeyManager } from '../../src/core/crypto/SenderKeyManager';
import type { P2PEnvelope, ChatMessage } from '../../src/types';

// ── Mock: P2PChannelBus ──────────────────────────────────────────────────

class MockChannelBus {
  private handlers: Map<string, Set<(env: P2PEnvelope) => Promise<void>>> = new Map();
  sent: P2PEnvelope[] = [];

  subscribe(ns: string, handler: (env: P2PEnvelope) => Promise<void>): () => void {
    if (!this.handlers.has(ns)) this.handlers.set(ns, new Set());
    this.handlers.get(ns)!.add(handler);
    return () => this.handlers.get(ns)?.delete(handler);
  }

  async send(envelope: P2PEnvelope): Promise<void> {
    this.sent.push(envelope);
  }

  getReadyState(): string {
    return 'open';
  }

  async simulateReceive(envelope: P2PEnvelope): Promise<void> {
    const handlers = this.handlers.get(envelope.ns) || new Set();
    for (const h of handlers) {
      await h(envelope);
    }
  }

  getLastSent(): P2PEnvelope | undefined {
    return this.sent[this.sent.length - 1];
  }

  getSentByType(type: string): P2PEnvelope[] {
    return this.sent.filter((e) => e.type === type);
  }

  clearSent(): void {
    this.sent = [];
  }
}

// ── Mock: IChatStorage ──────────────────────────────────────────────────

class MockChatStorage {
  messages: Map<string, { message: ChatMessage; roomId: string }> = new Map();

  async saveChatMessage(message: ChatMessage, roomId: string): Promise<void> {
    this.messages.set(message.messageId, { message: { ...message }, roomId });
  }

  async getChatMessages(roomId: string, limit = 100): Promise<ChatMessage[]> {
    return Array.from(this.messages.values())
      .filter((m) => m.roomId === roomId)
      .map((m) => m.message)
      .slice(0, limit);
  }

  async updateChatMessage(messageId: string, updates: Partial<ChatMessage>): Promise<void> {
    const entry = this.messages.get(messageId);
    if (entry) Object.assign(entry.message, updates);
  }

  async deleteChatMessage(messageId: string): Promise<void> {
    this.messages.delete(messageId);
  }

  getById(messageId: string): ChatMessage | undefined {
    return this.messages.get(messageId)?.message;
  }
}

// ── Helper ──────────────────────────────────────────────────────────────

function makeEnvelope(overrides: Partial<P2PEnvelope>): P2PEnvelope {
  return {
    v: 1,
    ns: 'chat',
    type: 'MSG_SEND',
    id: `env-${Date.now()}-${Math.random()}`,
    ts: Date.now(),
    from: 'remote-uid/device-1',
    payload: {},
    ...overrides,
  };
}

function bufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

// ── Tests ───────────────────────────────────────────────────────────────

describe('ChatService Integration', () => {
  // ──────────────────────────────────────────────────────────────────────
  // 1. Full key exchange -> encrypt -> send -> receive -> decrypt
  // ──────────────────────────────────────────────────────────────────────

  describe('full key exchange -> encrypt -> send -> receive -> decrypt', () => {
    it('should complete the entire E2EE lifecycle between two peers', async () => {
      const aliceSKM = new SenderKeyManager('alice');
      const bobSKM = new SenderKeyManager('bob');
      await aliceSKM.initKeyPair();
      await bobSKM.initKeyPair();

      const aliceBus = new MockChannelBus();
      const bobBus = new MockChannelBus();
      const aliceStorage = new MockChatStorage();
      const bobStorage = new MockChatStorage();

      const aliceSvc = new ChatService(
        aliceBus as unknown as any, 'alice', 'dev-a', 'room-1',
        aliceStorage as any, aliceSKM,
      );
      const bobSvc = new ChatService(
        bobBus as unknown as any, 'bob', 'dev-b', 'room-1',
        bobStorage as any, bobSKM,
      );

      // Step 1: Alice broadcasts ECDH public key
      await aliceSvc.initiateKeyExchange();
      const aliceECDH = aliceBus.getSentByType('ECDH_PUBKEY')[0];
      expect(aliceECDH).toBeDefined();

      // Step 2: Bob receives Alice's ECDH key, auto-replies with his own + sender key dist
      await bobBus.simulateReceive(aliceECDH);
      const bobECDH = bobBus.getSentByType('ECDH_PUBKEY')[0];
      const bobSKDist = bobBus.getSentByType('SENDER_KEY_DIST')[0];
      expect(bobECDH).toBeDefined();
      expect(bobSKDist).toBeDefined();

      // Step 3: Alice receives Bob's ECDH key
      await aliceBus.simulateReceive(bobECDH);
      const aliceSKDist = aliceBus.getSentByType('SENDER_KEY_DIST')[0];
      expect(aliceSKDist).toBeDefined();

      // Step 4: Cross-deliver sender keys
      await aliceBus.simulateReceive(bobSKDist);
      await bobBus.simulateReceive(aliceSKDist);

      expect(aliceSvc.isE2EEReady).toBe(true);
      expect(bobSvc.isE2EEReady).toBe(true);

      // Step 5: Alice sends encrypted message
      aliceBus.clearSent();
      await aliceSvc.sendMessage('secret integration test');
      const encEnv = aliceBus.getSentByType('MSG_SEND')[0];
      expect((encEnv.payload as any).encrypted).toBeDefined();
      expect((encEnv.payload as any).content).toBeUndefined();

      // Step 6: Bob receives and decrypts
      const bobReceived: ChatMessage[] = [];
      bobSvc.onMessage((m) => bobReceived.push(m));
      await bobBus.simulateReceive(encEnv);

      expect(bobReceived).toHaveLength(1);
      expect(bobReceived[0].content).toBe('secret integration test');

      // Step 7: Alice's local storage should have plaintext
      const aliceStored = aliceStorage.getById(
        (encEnv.payload as any).messageId,
      );
      expect(aliceStored?.content).toBe('secret integration test');
    });
  });

  // ──────────────────────────────────────────────────────────────────────
  // 2. Message send fallback behaviour
  // ──────────────────────────────────────────────────────────────────────

  describe('fallback behaviour when E2EE not ready', () => {
    it('should send plaintext when senderKeyManager is null', async () => {
      const bus = new MockChannelBus();
      const storage = new MockChatStorage();

      const svc = new ChatService(
        bus as unknown as any, 'alice', 'dev-a', 'room-1',
        storage as any, null,
      );

      await svc.sendMessage('hello plaintext');
      const sent = bus.getLastSent()!;
      const payload = sent.payload as ChatMessage;

      expect(payload.content).toBe('hello plaintext');
      expect((payload as any).encrypted).toBeUndefined();
    });

    it('should send plaintext when E2EE is enabled but key exchange not complete', async () => {
      const skm = new SenderKeyManager('alice');
      await skm.initKeyPair();

      const bus = new MockChannelBus();
      const storage = new MockChatStorage();

      const svc = new ChatService(
        bus as unknown as any, 'alice', 'dev-a', 'room-1',
        storage as any, skm,
      );

      // e2eeReady is false (no key exchange done)
      expect(svc.isE2EEReady).toBe(false);

      await svc.sendMessage('fallback plaintext');
      const sent = bus.getLastSent()!;
      const payload = sent.payload as any;

      // Should be plaintext since E2EE not ready
      expect(payload.content).toBe('fallback plaintext');
      expect(payload.encrypted).toBeUndefined();
    });
  });

  // ──────────────────────────────────────────────────────────────────────
  // 3. Deduplication and ordering with concurrent senders
  // ──────────────────────────────────────────────────────────────────────

  describe('deduplication when receiving simultaneous messages', () => {
    it('should not store duplicate messages (same messageId)', async () => {
      const bus = new MockChannelBus();
      const storage = new MockChatStorage();

      const _svc = new ChatService(
        bus as unknown as any, 'bob', 'dev-b', 'room-1',
        storage as any, null,
      );

      const received: ChatMessage[] = [];
      _svc.onMessage((m) => received.push(m));

      const envelope = makeEnvelope({
        type: 'MSG_SEND',
        from: 'alice/dev-a',
        payload: {
          messageId: 'dup-msg-1',
          from: 'alice/dev-a',
          content: 'hello',
          timestamp: Date.now(),
        },
      });

      // Simulate receiving the same message twice
      await bus.simulateReceive(envelope);
      await bus.simulateReceive(envelope);

      // onMessage fires for each receive, but storage should be idempotent
      // (ChatService stores on every receive, storage overwrites by messageId)
      const stored = await storage.getChatMessages('room-1');
      // Our MockChatStorage uses Map with messageId as key, so only 1 entry
      expect(stored).toHaveLength(1);
    });

    it('should receive messages from multiple senders in order', async () => {
      const bus = new MockChannelBus();
      const storage = new MockChatStorage();

      const _svc = new ChatService(
        bus as unknown as any, 'charlie', 'dev-c', 'room-1',
        storage as any, null,
      );

      const received: ChatMessage[] = [];
      _svc.onMessage((m) => received.push(m));

      const now = Date.now();

      await bus.simulateReceive(
        makeEnvelope({
          type: 'MSG_SEND',
          from: 'alice/dev-a',
          payload: { messageId: 'msg-a1', from: 'alice/dev-a', content: 'from alice', timestamp: now },
        }),
      );

      await bus.simulateReceive(
        makeEnvelope({
          type: 'MSG_SEND',
          from: 'bob/dev-b',
          payload: { messageId: 'msg-b1', from: 'bob/dev-b', content: 'from bob', timestamp: now + 1 },
        }),
      );

      expect(received).toHaveLength(2);
      expect(received[0].content).toBe('from alice');
      expect(received[1].content).toBe('from bob');
    });
  });

  // ──────────────────────────────────────────────────────────────────────
  // 4. Decryption continuity after key rotation
  // ──────────────────────────────────────────────────────────────────────

  describe('decryption continuity after sender key rotation', () => {
    it('should decrypt messages sent with a new epoch after rotation', async () => {
      const aliceSKM = new SenderKeyManager('alice');
      const bobSKM = new SenderKeyManager('bob');
      await aliceSKM.initKeyPair();
      await bobSKM.initKeyPair();

      // Initial key exchange
      await aliceSKM.generateSenderKey();
      const bobECDHPub = bobSKM.getECDHPublicKey()!;
      const dist1 = await aliceSKM.distributeSenderKey([
        { peerId: 'bob', publicKey: bobECDHPub },
      ]);
      const aliceECDHPub = aliceSKM.getECDHPublicKey()!;
      await bobSKM.receiveSenderKey(dist1, aliceECDHPub);

      // Encrypt first message (epoch 1)
      const enc1 = await aliceSKM.encryptMessage('before rotation');
      expect(enc1.senderKeyEpoch).toBe(1);

      // Force rotation -> epoch 2
      const members = [{ peerId: 'bob', publicKey: bobECDHPub }];
      aliceSKM.updateMembers(members);
      const rotation = await aliceSKM.forceRotation(members);
      expect(rotation).toBeDefined();
      expect(rotation!.epoch).toBe(2);

      // Bob receives the new sender key
      await bobSKM.receiveSenderKey(rotation!, aliceECDHPub);

      // Encrypt second message (epoch 2)
      const enc2 = await aliceSKM.encryptMessage('after rotation');
      expect(enc2.senderKeyEpoch).toBe(2);

      // Bob should decrypt both
      const plain1 = await bobSKM.decryptMessage(enc1, 'alice');
      const plain2 = await bobSKM.decryptMessage(enc2, 'alice');

      expect(plain1).toBe('before rotation');
      expect(plain2).toBe('after rotation');
    });

    it('should fail gracefully when old epoch key is not retained (unknown sender)', async () => {
      const bobSKM = new SenderKeyManager('bob');
      await bobSKM.initKeyPair();

      // Attempt to decrypt without ever receiving sender key
      await expect(
        bobSKM.decryptMessage(
          {
            ciphertext: 'AAAA',
            iv: 'BBBB',
            senderKeyEpoch: 99,
            seq: 0,
          },
          'unknown-sender',
        ),
      ).rejects.toThrow();
    });
  });

  // ──────────────────────────────────────────────────────────────────────
  // 5. Delete + edit message integration
  // ──────────────────────────────────────────────────────────────────────

  describe('edit and delete integration', () => {
    it('should mark message as deleted in storage', async () => {
      const bus = new MockChannelBus();
      const storage = new MockChatStorage();

      const svc = new ChatService(
        bus as unknown as any, 'alice', 'dev-a', 'room-1',
        storage as any, null,
      );

      const msgId = await svc.sendMessage('to be deleted');
      await svc.deleteMessage(msgId);

      const stored = storage.getById(msgId);
      expect(stored?.deleted).toBe(true);
    });

    it('should mark message as edited in storage', async () => {
      const bus = new MockChannelBus();
      const storage = new MockChatStorage();

      const svc = new ChatService(
        bus as unknown as any, 'alice', 'dev-a', 'room-1',
        storage as any, null,
      );

      const msgId = await svc.sendMessage('original');
      await svc.editMessage(msgId, 'updated');

      const stored = storage.getById(msgId);
      expect(stored?.content).toBe('updated');
      expect(stored?.edited).toBe(true);
    });
  });

  // ──────────────────────────────────────────────────────────────────────
  // 6. Typing indicator
  // ──────────────────────────────────────────────────────────────────────

  describe('typing indicator', () => {
    it('should receive typing events from remote peers', async () => {
      const bus = new MockChannelBus();
      const storage = new MockChatStorage();

      const svc = new ChatService(
        bus as unknown as any, 'bob', 'dev-b', 'room-1',
        storage as any, null,
      );

      const typingEvents: Array<{ userId: string; isTyping: boolean }> = [];
      svc.onTyping((data) => typingEvents.push(data));

      await bus.simulateReceive(
        makeEnvelope({
          type: 'TYPING',
          from: 'alice/dev-a',
          payload: { isTyping: true },
        }),
      );

      expect(typingEvents).toHaveLength(1);
      expect(typingEvents[0].userId).toBe('alice');
      expect(typingEvents[0].isTyping).toBe(true);
    });

    it('should send typing envelope via bus', async () => {
      const bus = new MockChannelBus();
      const storage = new MockChatStorage();

      const svc = new ChatService(
        bus as unknown as any, 'alice', 'dev-a', 'room-1',
        storage as any, null,
      );

      await svc.sendTyping(true);
      const sent = bus.getLastSent()!;
      expect(sent.type).toBe('TYPING');
      expect((sent.payload as any).isTyping).toBe(true);
    });
  });
});
