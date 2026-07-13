/**
 * ADR-0023 P2-③ Phase 1：mesh typing（暫態 presence 通道）
 * - broadcastTyping 只送給「已連上」鄰居，payload 帶自己的 mesh userId
 * - 'connecting' 鄰居不送（lossy 對象僅限就緒連線）
 * - onTyping 收到 neighbor 的 TYPING ephemeral → 轉成 {userId,isTyping}
 * - 非 TYPING / 畸形 payload 不觸發 listener（縱深防禦）
 * - typing 不碰 gossip store/對帳：走 neighbor.sendEphemeral，非 send
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { MeshGossipManager } from '../../src/core/mesh/MeshGossipManager';

// ── Mocks ────────────────────────────────────────────────────────────────────
vi.mock('../../src/core/mesh/IdentityManager', () => ({
  IdentityManager: vi.fn().mockImplementation(function () {
    return {
      initialize: vi.fn().mockResolvedValue(undefined),
      getUserId: vi.fn().mockReturnValue('me-mesh-id'),
      exportPublicKey: vi.fn().mockResolvedValue('mock-pubkey'),
      getPrivateKey: vi.fn().mockReturnValue({} as CryptoKey),
      // 不提供 exportEcdhPublicKey → initialize 走「無 ECDH，退明文相容」分支，
      // keyCoordinator=null，避免 keyx 週期讀 RoomService.getRoom。
    };
  }),
}));

vi.mock('../../src/core/mesh/SecurityManager', () => ({
  SecurityManager: vi.fn().mockImplementation(function () {
    return {};
  }),
}));

function makeNeighbor(id: string, state: 'connected' | 'connecting' = 'connected') {
  let ephemeralHandler: ((env: { type: string; from?: string; payload: unknown }) => void) | null = null;
  return {
    getId: () => id,
    getState: () => state,
    onMessage: vi.fn(),
    onDigest: vi.fn(),
    onEphemeral: vi.fn((h: (env: { type: string; from?: string; payload: unknown }) => void) => {
      ephemeralHandler = h;
      return () => {};
    }),
    sendEphemeral: vi.fn().mockResolvedValue(undefined),
    sendDigest: vi.fn().mockResolvedValue(undefined),
    /** 測試輔助：模擬對方送來 presence 信號 */
    __emit: (env: { type: string; from?: string; payload: unknown }) => ephemeralHandler?.(env),
  };
}

let neighbors: ReturnType<typeof makeNeighbor>[] = [];

const mockTopologyManager = {
  initialize: vi.fn().mockResolvedValue(undefined),
  getNeighborCount: vi.fn().mockReturnValue(0),
  getNeighbors: vi.fn(() => neighbors),
  cleanup: vi.fn().mockResolvedValue(undefined),
};

vi.mock('../../src/core/mesh/MeshTopologyManager', () => ({
  MeshTopologyManager: vi.fn().mockImplementation(function () {
    return mockTopologyManager;
  }),
}));

const mockMessageHandler = {
  sendMessage: vi.fn().mockResolvedValue(undefined),
  onMessage: vi.fn().mockReturnValue(() => {}),
  hydrate: vi.fn().mockResolvedValue(undefined),
  sendDigestTo: vi.fn().mockResolvedValue(undefined),
};

vi.mock('../../src/core/mesh/GossipMessageHandler', () => ({
  GossipMessageHandler: vi.fn().mockImplementation(function () {
    return mockMessageHandler;
  }),
}));

vi.mock('../../src/services/RoomService', () => ({
  RoomService: { updateMeshIdentity: vi.fn().mockResolvedValue(undefined) },
}));

vi.mock('../../src/config/firebase', () => ({
  auth: { currentUser: { uid: 'firebase-uid-me' } },
  db: {},
}));

// ── Tests ────────────────────────────────────────────────────────────────────
describe('MeshGossipManager typing（P2-③ Phase 1）', () => {
  let manager: MeshGossipManager;

  beforeEach(() => {
    vi.useFakeTimers();
    neighbors = [];
    manager = new MeshGossipManager('room-typing', 'uid-typing');
  });

  afterEach(async () => {
    await manager.cleanup();
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it('broadcastTyping 送給已連上鄰居，payload 帶自己的 mesh userId', async () => {
    const n1 = makeNeighbor('peer-1');
    const n2 = makeNeighbor('peer-2');
    neighbors = [n1, n2];
    await manager.initialize();

    await manager.broadcastTyping(true);

    expect(n1.sendEphemeral).toHaveBeenCalledWith('TYPING', { userId: 'me-mesh-id', isTyping: true });
    expect(n2.sendEphemeral).toHaveBeenCalledWith('TYPING', { userId: 'me-mesh-id', isTyping: true });
    // 未動 gossip 可靠管線（typing 不入日誌/對帳）
    expect(mockMessageHandler.sendMessage).not.toHaveBeenCalled();
  });

  it("broadcastTyping 不送給 'connecting' 鄰居（lossy 僅限就緒連線）", async () => {
    const ready = makeNeighbor('peer-ready', 'connected');
    const half = makeNeighbor('peer-half', 'connecting');
    neighbors = [ready, half];
    await manager.initialize();

    await manager.broadcastTyping(false);

    expect(ready.sendEphemeral).toHaveBeenCalledWith('TYPING', { userId: 'me-mesh-id', isTyping: false });
    expect(half.sendEphemeral).not.toHaveBeenCalled();
  });

  it('onTyping 收到 peer 的 TYPING → 轉成 {userId,isTyping}', async () => {
    const n1 = makeNeighbor('peer-1');
    neighbors = [n1];
    await manager.initialize();
    // 觸發鄰居掃描，接上 onEphemeral（初始化後第一輪 2s 掃描）
    await vi.advanceTimersByTimeAsync(2000);

    const received: Array<{ userId: string; isTyping: boolean }> = [];
    manager.onTyping((d) => received.push(d));

    n1.__emit({ type: 'TYPING', from: 'fb-peer', payload: { userId: 'peer-1', isTyping: true } });

    expect(received).toEqual([{ userId: 'peer-1', isTyping: true }]);
  });

  it('onTyping 忽略非 TYPING 型別與畸形 payload（縱深防禦）', async () => {
    const n1 = makeNeighbor('peer-1');
    neighbors = [n1];
    await manager.initialize();
    await vi.advanceTimersByTimeAsync(2000);

    const received: unknown[] = [];
    manager.onTyping((d) => received.push(d));

    n1.__emit({ type: 'CURSOR', payload: { userId: 'peer-1', isTyping: true } }); // 非 TYPING
    n1.__emit({ type: 'TYPING', payload: { userId: 42, isTyping: true } }); // userId 非字串
    n1.__emit({ type: 'TYPING', payload: { userId: 'peer-1' } }); // 缺 isTyping

    expect(received).toHaveLength(0);
  });
});
