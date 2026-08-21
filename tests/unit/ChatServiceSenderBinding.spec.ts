/**
 * H-1 回歸：star 路徑 ChatService 的寄件者身分綁定。
 *
 * 修復前：入站訊息用 payload 自述的 from/senderId 查金鑰與標記寄件者，且無簽章 →
 * 惡意 peer 可冒名（往對方歷史注入「你說過的話」、或把金鑰註冊成他人 uid）。
 * 修復後：以「傳輸層 envelope.from」為權威，並拒絕 (a) 冒充本機、(b) 冒充非認證對端。
 *
 * @vitest-environment node
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { ChatService } from '../../src/features/chat/ChatService';
import type { P2PEnvelope, ChatMessage } from '../../src/types';

class MockChannelBus {
  private handlers = new Map<string, Set<(env: P2PEnvelope) => Promise<void>>>();
  subscribe(ns: string, handler: (env: P2PEnvelope) => Promise<void>): () => void {
    if (!this.handlers.has(ns)) this.handlers.set(ns, new Set());
    this.handlers.get(ns)!.add(handler);
    return () => this.handlers.get(ns)?.delete(handler);
  }
  async send(): Promise<void> {}
  getReadyState(): string { return 'open'; }
  async simulateReceive(env: P2PEnvelope): Promise<void> {
    for (const h of this.handlers.get(env.ns) || new Set()) await h(env);
  }
}

class MockChatStorage {
  saved: ChatMessage[] = [];
  async saveChatMessage(message: ChatMessage): Promise<void> { this.saved.push(message); }
  async getChatMessages(): Promise<ChatMessage[]> { return this.saved; }
  async updateChatMessage(): Promise<void> {}
  async deleteChatMessage(): Promise<void> {}
}

function plaintextMsg(from: string, payloadFrom: string, content: string): P2PEnvelope {
  return {
    v: 1,
    ns: 'chat',
    type: 'MSG_SEND',
    id: `env-${content}`,
    ts: Date.now(),
    from,
    payload: { messageId: `m-${content}`, from: payloadFrom, content, timestamp: Date.now() },
  };
}

describe('ChatService 寄件者身分綁定（H-1）', () => {
  let bus: MockChannelBus;
  let storage: MockChatStorage;
  let svc: ChatService;
  let received: ChatMessage[];

  beforeEach(() => {
    bus = new MockChannelBus();
    storage = new MockChatStorage();
    received = [];
    // 本機 = alice；認證對端 = bob（明文模式，senderKeyManager=null）
    svc = new ChatService(
      bus as never,
      'alice-uid',
      'dev-a',
      'room-1',
      storage as never,
      null,
      () => 'bob-uid'
    );
    svc.onMessage((m) => received.push(m));
  });

  it('拒絕冒充本機身分的入站訊息（B 送 from=alice）', async () => {
    await bus.simulateReceive(plaintextMsg('alice-uid/dev-x', 'alice-uid', 'fake-self'));
    expect(storage.saved).toHaveLength(0);
    expect(received).toHaveLength(0);
  });

  it('拒絕冒充非認證對端的入站訊息（from=mallory，對端應為 bob）', async () => {
    await bus.simulateReceive(plaintextMsg('mallory-uid/dev-x', 'mallory-uid', 'fake-3p'));
    expect(storage.saved).toHaveLength(0);
    expect(received).toHaveLength(0);
  });

  it('接受認證對端的訊息，且寄件者以 envelope.from 為準（不採 payload 謊報的 from）', async () => {
    // envelope.from = bob（認證對端），但 payload.from 謊報成 alice
    await bus.simulateReceive(plaintextMsg('bob-uid/dev-b', 'alice-uid', 'legit'));
    expect(storage.saved).toHaveLength(1);
    expect(storage.saved[0].from).toBe('bob-uid/dev-b'); // 非 payload 的 'alice-uid'
    expect(received).toHaveLength(1);
  });

  it('未知認證對端（getExpectedPeerUid 回 null）時仍擋自我冒充，但放行其他對端', async () => {
    const bus2 = new MockChannelBus();
    const svc2 = new ChatService(
      bus2 as never, 'alice-uid', 'dev-a', 'room-2', new MockChatStorage() as never, null,
      () => null
    );
    const got: ChatMessage[] = [];
    svc2.onMessage((m) => got.push(m));
    await bus2.simulateReceive(plaintextMsg('alice-uid/x', 'alice-uid', 'self')); // 擋（冒充本機）
    await bus2.simulateReceive(plaintextMsg('bob-uid/x', 'bob-uid', 'ok'));       // 放行（對端未知）
    expect(got.map((m) => m.content)).toEqual(['ok']);
  });
});
