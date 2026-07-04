/**
 * 測試 MeshChatService
 * - messageId 唯一性（修正了 Date.now() 碰撞問題）
 * - 訊息監聽器的訂閱 / 取消訂閱
 * - 歷史訊息載入
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MeshChatService } from '../../src/features/chat/MeshChatService';
import type { IChatStorage } from '../../src/ports';
import type { ChatMessage, GossipMessage } from '../../src/types';

// ── Mock MeshGossipManager ──────────────────────────────────────────────────
let capturedMessageHandler: ((msg: GossipMessage) => void) | null = null;

const mockGossipManager = {
  initialize: vi.fn().mockResolvedValue(undefined),
  sendMessage: vi.fn().mockResolvedValue(undefined),
  onMessage: vi.fn().mockImplementation((handler: (msg: GossipMessage) => void) => {
    capturedMessageHandler = handler;
  }),
  isInitialized: vi.fn().mockReturnValue(true),
  getConnectionState: vi.fn().mockReturnValue({ neighborCount: 1, totalNeighbors: 1 }),
  cleanup: vi.fn().mockResolvedValue(undefined),
};

vi.mock('../../src/core/mesh/MeshGossipManager', () => ({
  // Use regular function (not arrow) so vitest can call it as a constructor.
  // When a constructor returns a plain object, JS uses that object as the result.
  MeshGossipManager: vi.fn().mockImplementation(function () { return mockGossipManager; }),
}));

// ── Mock IndexedDBService（預設 import）────────────────────────────────────
vi.mock('../../src/services/IndexedDBService', () => ({
  indexedDBService: {
    saveChatMessage: vi.fn().mockResolvedValue(undefined),
    getChatMessages: vi.fn().mockResolvedValue([]),
    updateChatMessage: vi.fn().mockResolvedValue(undefined),
    deleteChatMessage: vi.fn().mockResolvedValue(undefined),
  },
}));

// ── 建立可控制的 chatStorage Mock ──────────────────────────────────────────
function makeMockStorage(history: ChatMessage[] = []): IChatStorage {
  const saved: ChatMessage[] = [];
  return {
    saveChatMessage: vi.fn().mockImplementation(async (msg: ChatMessage) => {
      saved.push(msg);
    }),
    getChatMessages: vi.fn().mockResolvedValue([...history]),
    updateChatMessage: vi.fn().mockResolvedValue(undefined),
    deleteChatMessage: vi.fn().mockResolvedValue(undefined),
  };
}

// ───────────────────────────────────────────────────────────────────────────

describe('MeshChatService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    capturedMessageHandler = null;
  });

  describe('messageId 唯一性', () => {
    it('連續快速發送時，每則訊息的 messageId 都不同', async () => {
      const storage = makeMockStorage();
      const service = new MeshChatService('room-1', 'user-1', storage);
      await service.initialize();

      // 同一毫秒內發送多則訊息（使用 fake timers 固定時間）
      vi.useFakeTimers();
      vi.setSystemTime(1_000_000);

      const ids: string[] = [];
      for (let i = 0; i < 10; i++) {
        const id = await service.sendMessage(`message-${i}`);
        ids.push(id);
      }

      vi.useRealTimers();

      const uniqueIds = new Set(ids);
      expect(uniqueIds.size).toBe(10);
    });

    it('messageId 格式包含 uid、timestamp 和 counter', async () => {
      const storage = makeMockStorage();
      const service = new MeshChatService('room-1', 'alice', storage);
      await service.initialize();

      const id = await service.sendMessage('hello');

      // 格式：{uid}-{timestamp}-{counter}
      expect(id).toMatch(/^alice-\d+-\d+$/);
    });

    it('counter 每次發送都遞增', async () => {
      const storage = makeMockStorage();
      const service = new MeshChatService('room-1', 'user-1', storage);
      await service.initialize();

      vi.useFakeTimers();
      vi.setSystemTime(999_999);

      const id1 = await service.sendMessage('msg1');
      const id2 = await service.sendMessage('msg2');
      const id3 = await service.sendMessage('msg3');

      vi.useRealTimers();

      const counters = [id1, id2, id3].map((id) => parseInt(id.split('-').pop()!));
      expect(counters[1]).toBe(counters[0]! + 1);
      expect(counters[2]).toBe(counters[1]! + 1);
    });
  });

  describe('訊息監聽器', () => {
    it('onMessage 監聽器可以訂閱並接收遠端訊息', async () => {
      const storage = makeMockStorage();
      const service = new MeshChatService('room-1', 'user-1', storage);
      await service.initialize();

      const received: ChatMessage[] = [];
      service.onMessage((msg) => received.push(msg));

      // 模擬收到遠端 Gossip 訊息
      expect(capturedMessageHandler).not.toBeNull();
      capturedMessageHandler!({
        senderId: 'remote-user',
        seq: 1,
        content: 'hello from remote',
        timestamp: Date.now(),
      });

      // 等待 async save
      await new Promise((r) => setTimeout(r, 0));

      expect(received).toHaveLength(1);
      expect(received[0]!.content).toBe('hello from remote');
      expect(received[0]!.from).toBe('remote-user');
    });

    it('取消訂閱後不再收到訊息', async () => {
      const storage = makeMockStorage();
      const service = new MeshChatService('room-1', 'user-1', storage);
      await service.initialize();

      const received: ChatMessage[] = [];
      const unsubscribe = service.onMessage((msg) => received.push(msg));

      // 取消訂閱
      unsubscribe();

      capturedMessageHandler!({
        senderId: 'remote-user',
        seq: 2,
        content: 'this should not arrive',
        timestamp: Date.now(),
      });

      await new Promise((r) => setTimeout(r, 0));
      expect(received).toHaveLength(0);
    });

    it('sendMessage 也會觸發本地監聽器', async () => {
      const storage = makeMockStorage();
      const service = new MeshChatService('room-1', 'user-1', storage);
      await service.initialize();

      const received: ChatMessage[] = [];
      service.onMessage((msg) => received.push(msg));

      await service.sendMessage('local message');

      expect(received).toHaveLength(1);
      expect(received[0]!.content).toBe('local message');
      expect(received[0]!.from).toBe('user-1');
    });
  });

  describe('去重回歸：寄件方不重複', () => {
    it('sendMessage 傳入 messageId 時，本地 emit 沿用該 id（與樂觀顯示共用）', async () => {
      const storage = makeMockStorage();
      const service = new MeshChatService('room-1', 'user-1', storage);
      await service.initialize();

      const received: ChatMessage[] = [];
      service.onMessage((msg) => received.push(msg));

      const returned = await service.sendMessage('hi', 'shared-id-123');

      expect(returned).toBe('shared-id-123');
      expect(received).toHaveLength(1);
      expect(received[0]!.messageId).toBe('shared-id-123');
    });

    it('gossip 把自己的訊息繞回時被過濾（senderId === localUid）', async () => {
      const storage = makeMockStorage();
      const service = new MeshChatService('room-1', 'user-1', storage);
      await service.initialize();

      const received: ChatMessage[] = [];
      service.onMessage((msg) => received.push(msg));

      // 模擬 gossip 把「本機」送出的訊息繞回
      capturedMessageHandler!({
        senderId: 'user-1',
        seq: 7,
        content: 'my own echo',
        timestamp: Date.now(),
      });
      // 對照：他人的訊息照收
      capturedMessageHandler!({
        senderId: 'other-user',
        seq: 8,
        content: 'from peer',
        timestamp: Date.now(),
      });

      await new Promise((r) => setTimeout(r, 0));

      expect(received).toHaveLength(1);
      expect(received[0]!.content).toBe('from peer');
    });
  });

  describe('歷史訊息', () => {
    it('loadHistory 從 storage 取得歷史', async () => {
      const history: ChatMessage[] = [
        { messageId: 'h1', from: 'user-a', content: 'Hi', timestamp: 1000 },
        { messageId: 'h2', from: 'user-b', content: 'Hey', timestamp: 2000 },
      ];
      const storage = makeMockStorage(history);
      const service = new MeshChatService('room-1', 'user-1', storage);
      await service.initialize();

      const loaded = await service.loadHistory();
      expect(loaded).toHaveLength(2);
      expect(loaded[0]!.messageId).toBe('h1');
      expect(loaded[1]!.messageId).toBe('h2');
    });
  });

  describe('cleanup', () => {
    it('cleanup 後 messageListeners 被清空', async () => {
      const storage = makeMockStorage();
      const service = new MeshChatService('room-1', 'user-1', storage);
      await service.initialize();

      const received: ChatMessage[] = [];
      service.onMessage((msg) => received.push(msg));

      await service.cleanup();

      // cleanup 後傳入訊息不應再被接收
      capturedMessageHandler?.({
        senderId: 'ghost',
        seq: 99,
        content: 'should be ignored',
        timestamp: Date.now(),
      });

      await new Promise((r) => setTimeout(r, 0));
      expect(received).toHaveLength(0);
    });
  });
});
