/**
 * ChatService E2EE 接線行為測試（ADR-0004）
 *
 * 驗證本次接線新增的守衛與 fallback 加解密：
 *  - E2EE 模式下金鑰未就緒：sendMessage 等待而非降級明文
 *  - 金鑰交換逾時：sendMessage 擲錯且不外送任何明文
 *  - ECDH_PUBKEY 重複接收（相同公鑰）不再回播（防無限迴圈）
 *  - encryptForFallback / decryptFromFallback 往返
 *  - fallback 密文帶 seq，重放被拒
 *
 * @vitest-environment node
 */
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { ChatService } from '../../src/features/chat/ChatService';
import { SenderKeyManager } from '../../src/core/crypto/SenderKeyManager';
import type { P2PEnvelope, ChatMessage } from '../../src/types';

// ── Mocks（與 ChatServiceE2EE.spec.ts 同款） ────────────────────────────

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

  getSentByType(type: string): P2PEnvelope[] {
    return this.sent.filter((e) => e.type === type);
  }
}

class MockChatStorage {
  messages: Map<string, { message: ChatMessage; roomId: string }> = new Map();

  async saveChatMessage(message: ChatMessage, roomId: string): Promise<void> {
    this.messages.set(message.messageId, { message, roomId });
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
}

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

async function exportPubKeyBase64(skm: SenderKeyManager): Promise<string> {
  const exported = await crypto.subtle.exportKey('spki', skm.getECDHPublicKey()!);
  const bytes = new Uint8Array(exported);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

// ── Tests ───────────────────────────────────────────────────────────────

describe('ChatService E2EE wiring (ADR-0004)', () => {
  let aliceSKM: SenderKeyManager;
  let bobSKM: SenderKeyManager;

  beforeEach(async () => {
    aliceSKM = new SenderKeyManager('alice-uid');
    bobSKM = new SenderKeyManager('bob-uid');
    await aliceSKM.initKeyPair();
    await bobSKM.initKeyPair();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('no silent plaintext downgrade', () => {
    it('sendMessage waits for key exchange instead of sending plaintext', async () => {
      await aliceSKM.generateSenderKey();

      const bus = new MockChannelBus();
      const storage = new MockChatStorage();
      const svc = new ChatService(
        bus as unknown as never,
        'alice-uid',
        'device-1',
        'room-1',
        storage as never,
        aliceSKM
      );

      // 金鑰未就緒時發送：應 pending，不應有任何 MSG_SEND 外送
      const sendPromise = svc.sendMessage('must not leak');
      await new Promise((r) => setTimeout(r, 50));
      expect(bus.getSentByType('MSG_SEND')).toHaveLength(0);

      // 送達 sender key → e2eeReady → 訊息以密文送出
      const dist = await bobSKM.forceRotation([
        { peerId: 'alice-uid', publicKey: aliceSKM.getECDHPublicKey()! },
      ]);
      await bus.simulateReceive(
        makeEnvelope({
          type: 'SENDER_KEY_DIST',
          from: 'bob-uid/device-1',
          payload: {
            senderId: 'bob-uid',
            epoch: dist!.epoch,
            ecdhPublicKey: await exportPubKeyBase64(bobSKM),
            encryptedKeys: dist!.encryptedKeys,
          },
        })
      );

      await sendPromise;
      const sent = bus.getSentByType('MSG_SEND');
      expect(sent).toHaveLength(1);
      const payload = sent[0].payload as { encrypted?: { ciphertext: string }; content?: string };
      expect(payload.encrypted?.ciphertext).toBeTruthy();
      expect(payload.content).toBeUndefined();
    });

    it('sendMessage rejects on key exchange timeout and sends nothing', async () => {
      vi.useFakeTimers();

      const bus = new MockChannelBus();
      const storage = new MockChatStorage();
      const svc = new ChatService(
        bus as unknown as never,
        'alice-uid',
        'device-1',
        'room-1',
        storage as never,
        aliceSKM
      );

      const sendPromise = svc.sendMessage('must not leak');
      const expectation = expect(sendPromise).rejects.toThrow('E2EE key exchange timed out');
      await vi.advanceTimersByTimeAsync(10_000);
      await expectation;

      // 沒有任何外送、也沒有本機殘留
      expect(bus.sent).toHaveLength(0);
      expect(storage.messages.size).toBe(0);
    });
  });

  describe('ECDH_PUBKEY re-broadcast guard', () => {
    it('ignores duplicate pubkey (no infinite ping-pong)', async () => {
      const bus = new MockChannelBus();
      const _svc = new ChatService(
        bus as unknown as never,
        'alice-uid',
        'device-1',
        'room-1',
        new MockChatStorage() as never,
        aliceSKM
      );

      const bobPubEnv = makeEnvelope({
        type: 'ECDH_PUBKEY',
        from: 'bob-uid/device-1',
        payload: { userId: 'bob-uid', ecdhPublicKey: await exportPubKeyBase64(bobSKM) },
      });

      await bus.simulateReceive(bobPubEnv);
      const ecdhAfterFirst = bus.getSentByType('ECDH_PUBKEY').length;
      const distAfterFirst = bus.getSentByType('SENDER_KEY_DIST').length;
      expect(ecdhAfterFirst).toBeGreaterThanOrEqual(1);
      expect(distAfterFirst).toBeGreaterThanOrEqual(1);

      // 同一把公鑰再收一次：不得再回播
      await bus.simulateReceive(bobPubEnv);
      expect(bus.getSentByType('ECDH_PUBKEY').length).toBe(ecdhAfterFirst);
      expect(bus.getSentByType('SENDER_KEY_DIST').length).toBe(distAfterFirst);
    });

    it('responds again when peer rotates its ECDH key (page reload)', async () => {
      const bus = new MockChannelBus();
      const _svc = new ChatService(
        bus as unknown as never,
        'alice-uid',
        'device-1',
        'room-1',
        new MockChatStorage() as never,
        aliceSKM
      );

      await bus.simulateReceive(
        makeEnvelope({
          type: 'ECDH_PUBKEY',
          from: 'bob-uid/device-1',
          payload: { userId: 'bob-uid', ecdhPublicKey: await exportPubKeyBase64(bobSKM) },
        })
      );
      const distAfterFirst = bus.getSentByType('SENDER_KEY_DIST').length;

      // Bob 重整後換了新金鑰 → 必須重新分發
      await bobSKM.initKeyPair();
      await bus.simulateReceive(
        makeEnvelope({
          type: 'ECDH_PUBKEY',
          from: 'bob-uid/device-1',
          payload: { userId: 'bob-uid', ecdhPublicKey: await exportPubKeyBase64(bobSKM) },
        })
      );
      expect(bus.getSentByType('SENDER_KEY_DIST').length).toBeGreaterThan(distAfterFirst);
    });

    it('ignores its own broadcast echo', async () => {
      const bus = new MockChannelBus();
      const _svc = new ChatService(
        bus as unknown as never,
        'alice-uid',
        'device-1',
        'room-1',
        new MockChatStorage() as never,
        aliceSKM
      );

      await bus.simulateReceive(
        makeEnvelope({
          type: 'ECDH_PUBKEY',
          from: 'alice-uid/device-1',
          payload: { userId: 'alice-uid', ecdhPublicKey: await exportPubKeyBase64(aliceSKM) },
        })
      );
      expect(bus.sent).toHaveLength(0);
    });
  });

  describe('fallback encryption helpers', () => {
    async function establishSession(): Promise<{ alice: ChatService; bob: ChatService }> {
      const aliceBus = new MockChannelBus();
      const bobBus = new MockChannelBus();
      const alice = new ChatService(
        aliceBus as unknown as never,
        'alice-uid',
        'device-1',
        'room-1',
        new MockChatStorage() as never,
        aliceSKM
      );
      const bob = new ChatService(
        bobBus as unknown as never,
        'bob-uid',
        'device-1',
        'room-1',
        new MockChatStorage() as never,
        bobSKM
      );

      // 完整金鑰交換（透過手動轉送 envelope）
      await alice.initiateKeyExchange();
      await bobBus.simulateReceive(aliceBus.getSentByType('ECDH_PUBKEY')[0]);
      await aliceBus.simulateReceive(bobBus.getSentByType('ECDH_PUBKEY')[0]);
      await aliceBus.simulateReceive(bobBus.getSentByType('SENDER_KEY_DIST')[0]);
      await bobBus.simulateReceive(aliceBus.getSentByType('SENDER_KEY_DIST')[0]);
      expect(alice.isE2EEReady).toBe(true);
      expect(bob.isE2EEReady).toBe(true);
      return { alice, bob };
    }

    it('round-trips content through encryptForFallback / decryptFromFallback', async () => {
      const { alice, bob } = await establishSession();

      const encrypted = await alice.encryptForFallback('via firestore, still secret');
      expect(encrypted.ciphertext).toBeTruthy();
      expect(typeof encrypted.seq).toBe('number');

      const plaintext = await bob.decryptFromFallback(encrypted, 'alice-uid');
      expect(plaintext).toBe('via firestore, still secret');
    });

    it('rejects replayed fallback payloads', async () => {
      const { alice, bob } = await establishSession();

      const encrypted = await alice.encryptForFallback('once only');
      await bob.decryptFromFallback(encrypted, 'alice-uid');
      await expect(bob.decryptFromFallback(encrypted, 'alice-uid')).rejects.toThrow(
        'Replay detected'
      );
    });

    it('encryptForFallback throws when E2EE is not enabled', async () => {
      const svc = new ChatService(
        new MockChannelBus() as unknown as never,
        'alice-uid',
        'device-1',
        'room-1',
        new MockChatStorage() as never,
        null
      );
      await expect(svc.encryptForFallback('x')).rejects.toThrow('E2EE not enabled');
    });
  });
});
