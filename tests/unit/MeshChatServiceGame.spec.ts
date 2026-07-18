/**
 * ADR-0023 P2-③ Phase 2：MeshChatService 遊戲通道（channel:'game'）
 * - sendGameEnvelope → meshGossipManager.sendMessage(JSON, id, 'game')
 * - onGameMessage 收到 channel:'game' → 解 JSON → 交遊戲監聽器（不進聊天）
 * - 聊天訊息不誤入遊戲監聽器；遊戲事件不誤入聊天監聽器（通道分流）
 * - 畸形 game envelope 不炸（skip）
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MeshChatService } from '../../src/features/chat/MeshChatService';
import type { GossipMessage, P2PEnvelope } from '../../src/types';

let capturedOnMessage: ((msg: GossipMessage) => void) | null = null;

const mockGossipManager = {
  initialize: vi.fn().mockResolvedValue(undefined),
  sendMessage: vi.fn().mockResolvedValue(undefined),
  onMessage: vi.fn().mockImplementation((h: (msg: GossipMessage) => void) => {
    capturedOnMessage = h;
    return () => {};
  }),
  isInitialized: vi.fn().mockReturnValue(true),
  // Spec 012 出口閘表面：預設 encrypted（放行），閘門行為由 MeshChatServiceGate.spec 專測
  getEncryptionState: vi.fn().mockReturnValue('encrypted'),
  waitForSendKey: vi.fn().mockResolvedValue(true),
  getConnectionState: vi.fn().mockReturnValue({ neighborCount: 1, totalNeighbors: 1 }),
  getUserId: vi.fn().mockReturnValue('me-mesh-id'),
  cleanup: vi.fn().mockResolvedValue(undefined),
};

vi.mock('../../src/core/mesh/MeshGossipManager', () => ({
  MeshGossipManager: vi.fn().mockImplementation(function () { return mockGossipManager; }),
}));

vi.mock('../../src/services/IndexedDBService', () => ({
  indexedDBService: {
    saveChatMessage: vi.fn().mockResolvedValue(undefined),
    getChatMessages: vi.fn().mockResolvedValue([]),
    updateChatMessage: vi.fn().mockResolvedValue(undefined),
    deleteChatMessage: vi.fn().mockResolvedValue(undefined),
  },
}));

function gameGossip(env: unknown, senderId = 'peer-x'): GossipMessage {
  return {
    roomId: 'r', senderId, pubKey: 'pk', seq: 1, timestamp: Date.now(),
    content: typeof env === 'string' ? env : JSON.stringify(env),
    ttl: 8, signature: 'sig', channel: 'game',
  };
}

const sampleEnv: P2PEnvelope = {
  v: 1, ns: 'ttt', type: 'MOVE', id: 'evt-1', ts: 123,
  from: 'peer-x', payload: { cell: 4, mark: 'X' },
};

describe('MeshChatService game channel（P2-③ Phase 2）', () => {
  let svc: MeshChatService;

  beforeEach(async () => {
    vi.clearAllMocks();
    capturedOnMessage = null;
    svc = new MeshChatService('room-g', 'me-fb-uid');
    await svc.initialize();
  });

  it('sendGameEnvelope 走 channel:\'game\'，id 作 messageId', async () => {
    await svc.sendGameEnvelope(sampleEnv);
    expect(mockGossipManager.sendMessage).toHaveBeenCalledWith(
      JSON.stringify(sampleEnv), 'evt-1', 'game'
    );
  });

  it('onGameMessage 收到 channel:\'game\' → 解 JSON 交遊戲監聽器', () => {
    const games: P2PEnvelope[] = [];
    svc.onGameMessage((e) => games.push(e));
    capturedOnMessage!(gameGossip(sampleEnv));
    expect(games).toEqual([sampleEnv]);
  });

  it('遊戲事件不進聊天監聽器；聊天不進遊戲監聽器（通道分流）', () => {
    const chats: unknown[] = [];
    const games: unknown[] = [];
    svc.onMessage((m) => chats.push(m));
    svc.onGameMessage((e) => games.push(e));

    // 遊戲事件
    capturedOnMessage!(gameGossip(sampleEnv));
    // 聊天訊息（無 channel → chat）
    capturedOnMessage!({
      roomId: 'r', senderId: 'peer-x', pubKey: 'pk', seq: 2, timestamp: Date.now(),
      content: '哈囉', ttl: 8, signature: 'sig',
    });

    expect(games).toHaveLength(1);
    expect(chats).toHaveLength(1);
    expect((chats[0] as { content: string }).content).toBe('哈囉');
  });

  it('畸形 game envelope 不炸、不觸發監聽器', () => {
    const games: unknown[] = [];
    svc.onGameMessage((e) => games.push(e));
    expect(() => capturedOnMessage!(gameGossip('{ not json', 'peer-x'))).not.toThrow();
    expect(games).toHaveLength(0);
  });

  it('cleanup 後遊戲監聽器清空', async () => {
    const games: unknown[] = [];
    svc.onGameMessage((e) => games.push(e));
    await svc.cleanup();
    // cleanup 後即使再有事件進來也不派送（監聽器已清）
    capturedOnMessage?.(gameGossip(sampleEnv));
    expect(games).toHaveLength(0);
  });
});
