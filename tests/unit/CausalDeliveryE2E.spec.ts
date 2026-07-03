/**
 * 因果排序端到端測試（GC2）
 *
 * 驗證發送端填 deps + 接收端 CausalOrderingBuffer 能還原因果順序：
 *  - ChatService.sendMessage 產生的 payload 帶正確的 deps（因果前緣）
 *  - 亂序到達（後續訊息先到）時，緩衝器保留到依賴滿足才遞交
 *  - 依賴滿足後按因果順序遞交
 *  - 空 deps 的首則訊息會登記，使後續依賴它的訊息不卡 timeout
 *
 * @vitest-environment node
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { ChatService } from '../../src/features/chat/ChatService';
import { CausalOrderingBuffer } from '../../src/core/ordering/CausalOrderingBuffer';
import type { P2PEnvelope, ChatMessage, CausalMessage } from '../../src/types';

class MockChannelBus {
  private handlers = new Map<string, Set<(env: P2PEnvelope) => Promise<void>>>();
  sent: P2PEnvelope[] = [];
  subscribe(ns: string, h: (env: P2PEnvelope) => Promise<void>): () => void {
    if (!this.handlers.has(ns)) this.handlers.set(ns, new Set());
    this.handlers.get(ns)!.add(h);
    return () => this.handlers.get(ns)?.delete(h);
  }
  async send(env: P2PEnvelope): Promise<void> {
    this.sent.push(env);
  }
  getReadyState() {
    return 'open';
  }
  getSentByType(type: string) {
    return this.sent.filter((e) => e.type === type);
  }
}

class MockChatStorage {
  async saveChatMessage(): Promise<void> {}
  async getChatMessages(): Promise<ChatMessage[]> {
    return [];
  }
  async updateChatMessage(): Promise<void> {}
  async deleteChatMessage(): Promise<void> {}
}

describe('Causal delivery E2E (GC2)', () => {
  describe('send side attaches deps (causal frontier)', () => {
    let bus: MockChannelBus;
    let svc: ChatService;

    beforeEach(() => {
      bus = new MockChannelBus();
      svc = new ChatService(
        bus as unknown as never,
        'alice',
        'device-1',
        'room-1',
        new MockChatStorage() as never,
        null
      );
    });

    it('first message has empty deps; subsequent messages depend on the previous', async () => {
      await svc.sendMessage('m1');
      await svc.sendMessage('m2');
      await svc.sendMessage('m3');

      const sent = bus.getSentByType('MSG_SEND').map((e) => e.payload as CausalMessage);
      expect(sent[0].deps).toEqual([]);
      expect(sent[1].deps).toEqual([sent[0].messageId]);
      expect(sent[2].deps).toEqual([sent[1].messageId]);
    });

    it('a received message enters the frontier so the next sent message depends on it', async () => {
      await svc.sendMessage('local-1');
      const localId = (bus.getSentByType('MSG_SEND')[0].payload as CausalMessage).messageId;

      // 模擬收到遠端訊息
      await bus['handlers'].get('chat')!.values().next().value!({
        v: 1,
        ns: 'chat',
        type: 'MSG_SEND',
        id: 'e1',
        ts: Date.now(),
        from: 'bob/device-2',
        payload: {
          messageId: 'remote-1',
          from: 'bob/device-2',
          content: 'hi',
          timestamp: Date.now(),
          deps: [localId],
        },
      } as P2PEnvelope);

      await svc.sendMessage('local-2');
      const local2 = bus.getSentByType('MSG_SEND')[1].payload as CausalMessage;
      // frontier 在 local-1 後 = [local-1]；收到 remote-1(deps=[local-1]) 後 = [remote-1]
      expect(local2.deps).toEqual(['remote-1']);
    });
  });

  describe('receive side reorders out-of-order arrivals', () => {
    it('holds a message until its dep is delivered, then delivers in causal order', () => {
      const buffer = new CausalOrderingBuffer();
      const delivered: string[] = [];
      buffer.onDeliver((m) => delivered.push(m.messageId));

      const m1: CausalMessage = { messageId: 'm1', from: 'a', content: '1', timestamp: 1, deps: [] };
      const m2: CausalMessage = { messageId: 'm2', from: 'a', content: '2', timestamp: 2, deps: ['m1'] };

      // 亂序：m2 先到，應被 buffer 保留（m1 未遞交）
      buffer.receive(m2);
      expect(delivered).toEqual([]);
      expect(buffer.pendingCount).toBe(1);

      // m1 到達 → m1 遞交，接著 m2 的依賴滿足也遞交
      buffer.receive(m1);
      expect(delivered).toEqual(['m1', 'm2']);
      expect(buffer.pendingCount).toBe(0);

      buffer.destroy();
    });

    it('empty-deps message registers as delivered so dependents do not stall', () => {
      const buffer = new CausalOrderingBuffer();
      const delivered: string[] = [];
      buffer.onDeliver((m) => delivered.push(m.messageId));

      const m1: CausalMessage = { messageId: 'm1', from: 'a', content: '1', timestamp: 1, deps: [] };
      const m2: CausalMessage = { messageId: 'm2', from: 'a', content: '2', timestamp: 2, deps: ['m1'] };

      // 依序但都經 buffer（含空 deps 的 m1）
      buffer.receive(m1);
      buffer.receive(m2);
      // m2 不應卡住，因為 m1 已登記於 deliveredSet
      expect(delivered).toEqual(['m1', 'm2']);
      expect(buffer.pendingCount).toBe(0);

      buffer.destroy();
    });
  });
});
