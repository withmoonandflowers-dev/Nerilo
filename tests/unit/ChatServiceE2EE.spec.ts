/**
 * ChatService E2EE 整合測試
 *
 * 驗證 E2EE 在 ChatService 中的完整流程：
 *  - 明文模式（無 SenderKeyManager）正常運作
 *  - 加密模式下 sendMessage 產生 EncryptedChatPayload
 *  - 加密模式下接收方正確解密
 *  - 金鑰交換流程（ECDH_PUBKEY → SENDER_KEY_DIST）
 *  - 編輯訊息的加解密
 *  - 解密失敗時的 graceful degradation
 *  - waitForE2EEReady 超時機制
 *
 * @vitest-environment node
 */
import { describe, it, expect, beforeEach, vi, type Mock } from 'vitest';
import { ChatService } from '../../src/features/chat/ChatService';
import { SenderKeyManager } from '../../src/core/crypto/SenderKeyManager';
import type { P2PEnvelope, ChatMessage } from '../../src/types';

// ── Mock：P2PChannelBus ──────────────────────────────────────────────────

class MockChannelBus {
  private handlers: Map<string, Set<(env: P2PEnvelope) => Promise<void>>> = new Map();
  sent: P2PEnvelope[] = [];

  subscribe(ns: string, handler: (env: P2PEnvelope) => Promise<void>): () => void {
    if (!this.handlers.has(ns)) {
      this.handlers.set(ns, new Set());
    }
    this.handlers.get(ns)!.add(handler);
    return () => this.handlers.get(ns)?.delete(handler);
  }

  async send(envelope: P2PEnvelope): Promise<void> {
    this.sent.push(envelope);
  }

  getReadyState(): string {
    return 'open';
  }

  /** 模擬收到一個 envelope（觸發 handler） */
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

// ── Mock：IChatStorage ──────────────────────────────────────────────────

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
    if (entry) {
      Object.assign(entry.message, updates);
    }
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

// ── Tests ───────────────────────────────────────────────────────────────

describe('ChatService E2EE Integration', () => {
  let bus: MockChannelBus;
  let storage: MockChatStorage;

  beforeEach(() => {
    bus = new MockChannelBus();
    storage = new MockChatStorage();
  });

  // ────────────────────────────────────────────────────────────────────
  //  明文模式
  // ────────────────────────────────────────────────────────────────────

  describe('plaintext mode (no SenderKeyManager)', () => {
    it('should send plaintext messages', async () => {
      const svc = new ChatService(
        bus as unknown as any,
        'alice-uid',
        'device-1',
        'room-1',
        storage as any,
        null
      );

      const msgId = await svc.sendMessage('hello world');
      expect(msgId).toBeTruthy();

      // 驗證 envelope payload 是明文 ChatMessage
      const sent = bus.getLastSent()!;
      expect(sent.type).toBe('MSG_SEND');
      const payload = sent.payload as ChatMessage;
      expect(payload.content).toBe('hello world');
      expect((payload as any).encrypted).toBeUndefined();
    });

    it('should receive and store plaintext messages', async () => {
      const svc = new ChatService(
        bus as unknown as any,
        'bob-uid',
        'device-1',
        'room-1',
        storage as any,
        null
      );

      const receivedMessages: ChatMessage[] = [];
      svc.onMessage((m) => receivedMessages.push(m));

      await bus.simulateReceive(
        makeEnvelope({
          type: 'MSG_SEND',
          from: 'alice-uid/device-1',
          payload: {
            messageId: 'msg-1',
            from: 'alice-uid/device-1',
            content: 'hi bob',
            timestamp: Date.now(),
          },
        })
      );

      expect(receivedMessages).toHaveLength(1);
      expect(receivedMessages[0].content).toBe('hi bob');
      expect(storage.getById('msg-1')?.content).toBe('hi bob');
    });

    it('isE2EEEnabled should be false', () => {
      const svc = new ChatService(
        bus as unknown as any,
        'alice-uid',
        'device-1',
        'room-1',
        storage as any,
        null
      );
      expect(svc.isE2EEEnabled).toBe(false);
      expect(svc.isE2EEReady).toBe(true); // always ready in plaintext mode
    });
  });

  // ────────────────────────────────────────────────────────────────────
  //  E2EE 模式
  // ────────────────────────────────────────────────────────────────────

  describe('E2EE mode', () => {
    let aliceSKM: SenderKeyManager;
    let bobSKM: SenderKeyManager;

    beforeEach(async () => {
      aliceSKM = new SenderKeyManager('alice-uid');
      bobSKM = new SenderKeyManager('bob-uid');
      await aliceSKM.initKeyPair();
      await bobSKM.initKeyPair();
    });

    it('isE2EEEnabled should be true', () => {
      const svc = new ChatService(
        bus as unknown as any,
        'alice-uid',
        'device-1',
        'room-1',
        storage as any,
        aliceSKM
      );
      expect(svc.isE2EEEnabled).toBe(true);
      expect(svc.isE2EEReady).toBe(false); // not ready until key exchange
    });

    it('should send encrypted messages after key exchange', async () => {
      const aliceBus = new MockChannelBus();
      const aliceSvc = new ChatService(
        aliceBus as unknown as any,
        'alice-uid',
        'device-1',
        'room-1',
        storage as any,
        aliceSKM
      );

      // 手動完成金鑰交換：Alice 生成 sender key + 模擬 e2eeReady
      await aliceSKM.generateSenderKey();
      // 使用 internal state hack to set e2eeReady
      (aliceSvc as any).e2eeReady = true;

      const msgId = await aliceSvc.sendMessage('secret hello');

      // 驗證 envelope 包含加密 payload
      const sent = aliceBus.getLastSent()!;
      expect(sent.type).toBe('MSG_SEND');
      const payload = sent.payload as any;
      expect(payload.encrypted).toBeDefined();
      expect(payload.encrypted.ciphertext).toBeTruthy();
      expect(payload.encrypted.iv).toBeTruthy();
      expect(payload.encrypted.senderKeyEpoch).toBe(1);
      // content 不應在 payload 中（已加密）
      expect(payload.content).toBeUndefined();

      // 本機 IndexedDB 應存明文
      const stored = storage.getById(msgId);
      expect(stored?.content).toBe('secret hello');
    });

    it('should decrypt received encrypted messages', async () => {
      // 完整的 Alice→Bob 加解密流程
      // 1. Alice 準備 sender key
      await aliceSKM.generateSenderKey();

      // 2. 交換 ECDH 公鑰 + 分發 sender key
      const aliceECDHPub = aliceSKM.getECDHPublicKey()!;
      const bobECDHPub = bobSKM.getECDHPublicKey()!;
      const dist = await aliceSKM.distributeSenderKey([
        { peerId: 'bob-uid', publicKey: bobECDHPub },
      ]);
      await bobSKM.receiveSenderKey(dist, aliceECDHPub);

      // 3. Alice 加密訊息
      const encrypted = await aliceSKM.encryptMessage('top secret');

      // 4. Bob 的 ChatService 接收加密 envelope
      const bobBus = new MockChannelBus();
      const bobStorage = new MockChatStorage();
      const bobSvc = new ChatService(
        bobBus as unknown as any,
        'bob-uid',
        'device-1',
        'room-1',
        bobStorage as any,
        bobSKM
      );
      (bobSvc as any).e2eeReady = true;

      const receivedMessages: ChatMessage[] = [];
      bobSvc.onMessage((m) => receivedMessages.push(m));

      await bobBus.simulateReceive(
        makeEnvelope({
          type: 'MSG_SEND',
          from: 'alice-uid/device-1',
          payload: {
            messageId: 'msg-enc-1',
            from: 'alice-uid/device-1',
            timestamp: Date.now(),
            encrypted: {
              ciphertext: encrypted.ciphertext,
              iv: encrypted.iv,
              senderKeyEpoch: encrypted.senderKeyEpoch,
              seq: encrypted.seq,
            },
          },
        })
      );

      // 驗證解密成功
      expect(receivedMessages).toHaveLength(1);
      expect(receivedMessages[0].content).toBe('top secret');
      expect(bobStorage.getById('msg-enc-1')?.content).toBe('top secret');
    });

    it('should show placeholder when decryption fails', async () => {
      const bobBus = new MockChannelBus();
      const bobStorage = new MockChatStorage();
      const bobSvc = new ChatService(
        bobBus as unknown as any,
        'bob-uid',
        'device-1',
        'room-1',
        bobStorage as any,
        bobSKM
      );
      (bobSvc as any).e2eeReady = true;

      const receivedMessages: ChatMessage[] = [];
      bobSvc.onMessage((m) => receivedMessages.push(m));

      // 傳入無法解密的 payload（Bob 沒有 Alice 的 sender key）
      await bobBus.simulateReceive(
        makeEnvelope({
          type: 'MSG_SEND',
          from: 'alice-uid/device-1',
          payload: {
            messageId: 'msg-bad-1',
            from: 'alice-uid/device-1',
            timestamp: Date.now(),
            encrypted: {
              ciphertext: 'invalid-base64-garbage==',
              iv: 'aGVsbG8gd29ybGQ=', // valid base64 but wrong
              senderKeyEpoch: 99,
            },
          },
        })
      );

      expect(receivedMessages).toHaveLength(1);
      expect(receivedMessages[0].content).toBe('[無法解密此訊息]');
    });

    it('should handle ECDH_PUBKEY envelope', async () => {
      const aliceBus = new MockChannelBus();
      const aliceSvc = new ChatService(
        aliceBus as unknown as any,
        'alice-uid',
        'device-1',
        'room-1',
        storage as any,
        aliceSKM
      );

      // Bob 的 ECDH 公鑰
      const bobECDHPub = bobSKM.getECDHPublicKey()!;
      const exported = await crypto.subtle.exportKey('spki', bobECDHPub);
      const base64Pub = bufferToBase64(exported);

      // 模擬 Alice 收到 Bob 的 ECDH_PUBKEY
      await aliceBus.simulateReceive(
        makeEnvelope({
          type: 'ECDH_PUBKEY',
          from: 'bob-uid/device-1',
          payload: {
            userId: 'bob-uid',
            ecdhPublicKey: base64Pub,
          },
        })
      );

      // Alice 應該回覆自己的 ECDH_PUBKEY + 分發 SENDER_KEY_DIST
      const ecdhSent = aliceBus.getSentByType('ECDH_PUBKEY');
      const skDistSent = aliceBus.getSentByType('SENDER_KEY_DIST');

      expect(ecdhSent.length).toBeGreaterThanOrEqual(1);
      expect(skDistSent.length).toBeGreaterThanOrEqual(1);

      // 驗證 SENDER_KEY_DIST 包含 Bob 的加密金鑰
      const distPayload = skDistSent[0].payload as any;
      expect(distPayload.senderId).toBe('alice-uid');
      expect(distPayload.epoch).toBeGreaterThan(0);
      expect(distPayload.encryptedKeys['bob-uid']).toBeDefined();
    });

    it('should handle SENDER_KEY_DIST envelope and mark E2EE ready', async () => {
      // Alice 準備分發資料
      await aliceSKM.generateSenderKey();
      const bobECDHPub = bobSKM.getECDHPublicKey()!;
      const dist = await aliceSKM.distributeSenderKey([
        { peerId: 'bob-uid', publicKey: bobECDHPub },
      ]);

      const aliceECDHPub = aliceSKM.getECDHPublicKey()!;
      const exported = await crypto.subtle.exportKey('spki', aliceECDHPub);
      const base64Pub = bufferToBase64(exported);

      // Bob 的 ChatService
      const bobBus = new MockChannelBus();
      const bobSvc = new ChatService(
        bobBus as unknown as any,
        'bob-uid',
        'device-1',
        'room-1',
        storage as any,
        bobSKM
      );

      expect(bobSvc.isE2EEReady).toBe(false);

      // Bob 收到 SENDER_KEY_DIST
      await bobBus.simulateReceive(
        makeEnvelope({
          type: 'SENDER_KEY_DIST',
          from: 'alice-uid/device-1',
          payload: {
            senderId: 'alice-uid',
            epoch: dist.epoch,
            ecdhPublicKey: base64Pub,
            encryptedKeys: dist.encryptedKeys,
          },
        })
      );

      expect(bobSvc.isE2EEReady).toBe(true);
    });

    it('waitForE2EEReady should resolve when key is received', async () => {
      await aliceSKM.generateSenderKey();
      const bobECDHPub = bobSKM.getECDHPublicKey()!;
      const dist = await aliceSKM.distributeSenderKey([
        { peerId: 'bob-uid', publicKey: bobECDHPub },
      ]);
      const aliceECDHPub = aliceSKM.getECDHPublicKey()!;
      const exported = await crypto.subtle.exportKey('spki', aliceECDHPub);
      const base64Pub = bufferToBase64(exported);

      const bobBus = new MockChannelBus();
      const bobSvc = new ChatService(
        bobBus as unknown as any,
        'bob-uid',
        'device-1',
        'room-1',
        storage as any,
        bobSKM
      );

      // 啟動 waitForE2EEReady（應該 pending）
      const waitPromise = bobSvc.waitForE2EEReady(5000);

      // 模擬短暫延遲後收到 sender key
      setTimeout(async () => {
        await bobBus.simulateReceive(
          makeEnvelope({
            type: 'SENDER_KEY_DIST',
            from: 'alice-uid/device-1',
            payload: {
              senderId: 'alice-uid',
              epoch: dist.epoch,
              ecdhPublicKey: base64Pub,
              encryptedKeys: dist.encryptedKeys,
            },
          })
        );
      }, 50);

      // 應在 timeout 前 resolve
      await expect(waitPromise).resolves.toBeUndefined();
    });

    it('waitForE2EEReady should reject on timeout', async () => {
      const bobBus = new MockChannelBus();
      const bobSvc = new ChatService(
        bobBus as unknown as any,
        'bob-uid',
        'device-1',
        'room-1',
        storage as any,
        bobSKM
      );

      await expect(bobSvc.waitForE2EEReady(100)).rejects.toThrow('E2EE key exchange timed out');
    });

    it('waitForE2EEReady should resolve immediately in plaintext mode', async () => {
      const svc = new ChatService(
        bus as unknown as any,
        'alice-uid',
        'device-1',
        'room-1',
        storage as any,
        null
      );
      await expect(svc.waitForE2EEReady(100)).resolves.toBeUndefined();
    });
  });

  // ────────────────────────────────────────────────────────────────────
  //  編輯訊息的 E2EE
  // ────────────────────────────────────────────────────────────────────

  describe('E2EE edit message', () => {
    it('should encrypt edit content', async () => {
      const aliceSKM = new SenderKeyManager('alice-uid');
      await aliceSKM.initKeyPair();
      await aliceSKM.generateSenderKey();

      const aliceBus = new MockChannelBus();
      const aliceSvc = new ChatService(
        aliceBus as unknown as any,
        'alice-uid',
        'device-1',
        'room-1',
        storage as any,
        aliceSKM
      );
      (aliceSvc as any).e2eeReady = true;

      // 先存一個訊息
      await storage.saveChatMessage(
        { messageId: 'msg-edit-1', from: 'alice-uid/device-1', content: 'old', timestamp: Date.now() },
        'room-1'
      );

      await aliceSvc.editMessage('msg-edit-1', 'new content');

      const sent = aliceBus.getLastSent()!;
      expect(sent.type).toBe('MSG_EDIT');
      const payload = sent.payload as any;
      // content 應為加密物件
      expect(typeof payload.content).toBe('object');
      expect(payload.content.ciphertext).toBeTruthy();
      expect(payload.content.iv).toBeTruthy();
      expect(payload.content.senderKeyEpoch).toBe(1);
    });

    it('should decrypt received edit', async () => {
      const aliceSKM = new SenderKeyManager('alice-uid');
      const bobSKM = new SenderKeyManager('bob-uid');
      await aliceSKM.initKeyPair();
      await bobSKM.initKeyPair();
      await aliceSKM.generateSenderKey();

      // 交換金鑰
      const dist = await aliceSKM.distributeSenderKey([
        { peerId: 'bob-uid', publicKey: bobSKM.getECDHPublicKey()! },
      ]);
      await bobSKM.receiveSenderKey(dist, aliceSKM.getECDHPublicKey()!);

      // Alice 加密編輯內容
      const encrypted = await aliceSKM.encryptMessage('updated text');

      // Bob 的 ChatService
      const bobBus = new MockChannelBus();
      const bobStorage = new MockChatStorage();
      await bobStorage.saveChatMessage(
        { messageId: 'msg-e-1', from: 'alice-uid/device-1', content: 'old', timestamp: Date.now() },
        'room-1'
      );

      const bobSvc = new ChatService(
        bobBus as unknown as any,
        'bob-uid',
        'device-1',
        'room-1',
        bobStorage as any,
        bobSKM
      );
      (bobSvc as any).e2eeReady = true;

      await bobBus.simulateReceive(
        makeEnvelope({
          type: 'MSG_EDIT',
          from: 'alice-uid/device-1',
          payload: {
            messageId: 'msg-e-1',
            content: {
              ciphertext: encrypted.ciphertext,
              iv: encrypted.iv,
              senderKeyEpoch: encrypted.senderKeyEpoch,
              seq: encrypted.seq,
            },
          },
        })
      );

      const stored = bobStorage.getById('msg-e-1');
      expect(stored?.content).toBe('updated text');
      expect(stored?.edited).toBe(true);
    });
  });

  // ────────────────────────────────────────────────────────────────────
  //  端到端完整流程
  // ────────────────────────────────────────────────────────────────────

  describe('full end-to-end flow', () => {
    it('Alice and Bob can exchange keys and communicate securely', async () => {
      const aliceSKM = new SenderKeyManager('alice-uid');
      const bobSKM = new SenderKeyManager('bob-uid');
      await aliceSKM.initKeyPair();
      await bobSKM.initKeyPair();

      const aliceBus = new MockChannelBus();
      const bobBus = new MockChannelBus();
      const aliceStorage = new MockChatStorage();
      const bobStorage = new MockChatStorage();

      const aliceSvc = new ChatService(
        aliceBus as unknown as any,
        'alice-uid',
        'device-1',
        'room-1',
        aliceStorage as any,
        aliceSKM
      );
      const bobSvc = new ChatService(
        bobBus as unknown as any,
        'bob-uid',
        'device-1',
        'room-1',
        bobStorage as any,
        bobSKM
      );

      // Step 1: Alice 廣播 ECDH 公鑰
      await aliceSvc.initiateKeyExchange();
      const aliceECDHEnv = aliceBus.getSentByType('ECDH_PUBKEY')[0];
      expect(aliceECDHEnv).toBeDefined();

      // Step 2: Bob 收到 Alice 的 ECDH 公鑰
      await bobBus.simulateReceive(aliceECDHEnv);

      // Bob 會回覆自己的 ECDH_PUBKEY + SENDER_KEY_DIST
      const bobECDHEnv = bobBus.getSentByType('ECDH_PUBKEY')[0];
      const bobSKDistEnv = bobBus.getSentByType('SENDER_KEY_DIST')[0];
      expect(bobECDHEnv).toBeDefined();
      expect(bobSKDistEnv).toBeDefined();

      // Step 3: Alice 收到 Bob 的 ECDH 公鑰
      await aliceBus.simulateReceive(bobECDHEnv);

      // Alice 也應分發 sender key
      const aliceSKDistEnv = aliceBus.getSentByType('SENDER_KEY_DIST')[0];
      expect(aliceSKDistEnv).toBeDefined();

      // Step 4: Alice 收到 Bob 的 sender key dist
      await aliceBus.simulateReceive(bobSKDistEnv);
      expect(aliceSvc.isE2EEReady).toBe(true);

      // Step 5: Bob 收到 Alice 的 sender key dist
      await bobBus.simulateReceive(aliceSKDistEnv);
      expect(bobSvc.isE2EEReady).toBe(true);

      // Step 6: Alice 發送加密訊息
      aliceBus.clearSent();
      await aliceSvc.sendMessage('hello bob, this is encrypted!');
      const encryptedEnv = aliceBus.getSentByType('MSG_SEND')[0];
      const encPayload = encryptedEnv.payload as any;
      expect(encPayload.encrypted).toBeDefined();
      expect(encPayload.encrypted.ciphertext).toBeTruthy();

      // Step 7: Bob 收到並解密
      const bobReceived: ChatMessage[] = [];
      bobSvc.onMessage((m) => bobReceived.push(m));
      await bobBus.simulateReceive(encryptedEnv);

      expect(bobReceived).toHaveLength(1);
      expect(bobReceived[0].content).toBe('hello bob, this is encrypted!');
    });
  });
});

// ── Helpers ──────────────────────────────────────────────────────────────────

function bufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}
