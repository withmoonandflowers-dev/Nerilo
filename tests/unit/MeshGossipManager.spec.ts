/**
 * MeshGossipManager 單元測試
 *
 * 覆蓋修復項目：
 * - cleanup() 應清除 neighborCheckInterval（修復記憶體洩漏）
 * - 初始化後 isInitialized() 應回傳 true
 * - 未初始化時呼叫 sendMessage / onMessage 應拋錯
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { MeshGossipManager } from '../../src/core/mesh/MeshGossipManager';

// ── Mocks ────────────────────────────────────────────────────────────────────

vi.mock('../../src/core/mesh/IdentityManager', () => ({
  IdentityManager: vi.fn().mockImplementation(function () {
    return {
      initialize: vi.fn().mockResolvedValue(undefined),
      getUserId: vi.fn().mockReturnValue('user-abc'),
      exportPublicKey: vi.fn().mockResolvedValue('mock-pubkey'),
      getPrivateKey: vi.fn().mockReturnValue({} as CryptoKey),
    };
  }),
}));

vi.mock('../../src/core/mesh/SecurityManager', () => ({
  SecurityManager: vi.fn().mockImplementation(function () {
    return {};
  }),
}));

const mockTopologyManager = {
  initialize: vi.fn().mockResolvedValue(undefined),
  getNeighborCount: vi.fn().mockReturnValue(0),
  getNeighbors: vi.fn().mockReturnValue([]),
  cleanup: vi.fn().mockResolvedValue(undefined),
  // Spec 011：拓撲自適應接線
  updateParticipantCount: vi.fn(),
  getTargetNeighborCount: vi.fn().mockReturnValue(6),
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
  handleReceivedMessage: vi.fn().mockResolvedValue(undefined),
  handleDigest: vi.fn().mockResolvedValue(undefined),
};

vi.mock('../../src/core/mesh/GossipMessageHandler', () => ({
  GossipMessageHandler: vi.fn().mockImplementation(function () {
    return mockMessageHandler;
  }),
}));

vi.mock('../../src/services/RoomService', () => ({
  RoomService: {
    updateMeshIdentity: vi.fn().mockResolvedValue(undefined),
  },
}));

vi.mock('../../src/config/firebase', () => ({
  auth: {
    currentUser: { uid: 'firebase-uid-123' },
  },
  db: {},
}));

// ── Tests ────────────────────────────────────────────────────────────────────

describe('MeshGossipManager', () => {
  let manager: MeshGossipManager;

  beforeEach(() => {
    vi.useFakeTimers();
    manager = new MeshGossipManager('room-xyz', 'firebase-uid-123');
  });

  afterEach(async () => {
    await manager.cleanup();
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  // ── 未初始化保護 ──────────────────────────────────────────────────────────

  describe('未初始化保護', () => {
    it('initialize() 前呼叫 sendMessage 應拋錯', async () => {
      await expect(manager.sendMessage('hello')).rejects.toThrow('not initialized');
    });

    it('initialize() 前呼叫 onMessage 應拋錯', () => {
      expect(() => manager.onMessage(vi.fn())).toThrow('not initialized');
    });

    it('initialize() 前 isInitialized() 應回傳 false', () => {
      expect(manager.isInitialized()).toBe(false);
    });

    it('initialize() 前 getConnectionState() 應回傳 isConnected: false', () => {
      const state = manager.getConnectionState();
      expect(state.isConnected).toBe(false);
      expect(state.neighborCount).toBe(0);
    });
  });

  // ── 初始化 ────────────────────────────────────────────────────────────────

  describe('initialize()', () => {
    it('初始化後 isInitialized() 應回傳 true', async () => {
      await manager.initialize();
      expect(manager.isInitialized()).toBe(true);
    });

    it('重複呼叫 initialize() 不應拋錯（幂等）', async () => {
      await manager.initialize();
      await expect(manager.initialize()).resolves.toBeUndefined();
    });
  });

  // ── 拓撲自適應接線（Spec 011）─────────────────────────────────────────────

  describe('拓撲自適應接線（Spec 011）', () => {
    function makeWatchableDirectory() {
      let watchCb:
        | ((snap: { meshIdentities: Record<string, unknown>; participants: string[] }) => void)
        | null = null;
      return {
        directory: {
          registerIdentity: vi.fn().mockResolvedValue(undefined),
          getSnapshot: vi.fn().mockResolvedValue({ meshIdentities: {}, participants: [] }),
          watchIdentities: vi.fn((cb: typeof watchCb) => {
            watchCb = cb;
            return () => {
              watchCb = null;
            };
          }),
        },
        push(snap: { meshIdentities: Record<string, unknown>; participants: string[] }) {
          watchCb?.(snap);
        },
      };
    }

    it('名冊 watch push 以 rosterFromRoom 人數（participants 集合大小）餵 updateParticipantCount', async () => {
      const { directory, push } = makeWatchableDirectory();
      const mgr = new MeshGossipManager(
        'room-topo',
        'firebase-uid-123',
        undefined,
        directory as never
      );
      await mgr.initialize();

      push({
        meshIdentities: { a: { userId: 'ua' }, b: { userId: 'ub' } },
        participants: ['a', 'b', 'c', 'd', 'e', 'f', 'g'],
      });
      expect(mockTopologyManager.updateParticipantCount).toHaveBeenCalledWith(7);

      await mgr.cleanup();
    });

    it('getConnectionState 透出 targetNeighbors（供橋接條件與 UI 覆蓋率）', async () => {
      const { directory } = makeWatchableDirectory();
      const mgr = new MeshGossipManager(
        'room-topo',
        'firebase-uid-123',
        undefined,
        directory as never
      );
      await mgr.initialize();
      mockTopologyManager.getTargetNeighborCount.mockReturnValue(3);
      expect(mgr.getConnectionState().targetNeighbors).toBe(3);
      await mgr.cleanup();
    });
  });

  // ── 加密狀態（ADR-0026 R2）────────────────────────────────────────────────
  describe('getEncryptionState()', () => {
    it('未初始化 → exchanging（安全預設，不誤報明文/已加密）', () => {
      expect(manager.getEncryptionState()).toBe('exchanging');
    });

    it('初始化後、mock 無 ECDH → keyCoordinator=null → plaintext（真降級）', async () => {
      // IdentityManager mock 未提供 exportEcdhPublicKey → ECDH 不可用分支 → keyCoordinator=null
      await manager.initialize();
      expect(manager.getEncryptionState()).toBe('plaintext');
    });
  });

  // ── cleanup() 清除 interval ───────────────────────────────────────────────

  describe('cleanup()', () => {
    it('cleanup() 後 isInitialized() 應回傳 false', async () => {
      await manager.initialize();
      await manager.cleanup();
      expect(manager.isInitialized()).toBe(false);
    });

    it('cleanup() 應清除 neighborCheckInterval（計時器不再觸發）', async () => {
      await manager.initialize();

      // 確認 interval 已啟動（推進 2 秒後 getNeighbors 應被呼叫）
      vi.advanceTimersByTime(2000);
      const callsBefore = mockTopologyManager.getNeighbors.mock.calls.length;
      expect(callsBefore).toBeGreaterThanOrEqual(1);

      // cleanup
      await manager.cleanup();

      // 推進更多時間後，不應再有新的 getNeighbors 呼叫
      const callsAfterCleanup = mockTopologyManager.getNeighbors.mock.calls.length;
      vi.advanceTimersByTime(10000);
      expect(mockTopologyManager.getNeighbors.mock.calls.length).toBe(callsAfterCleanup);
    });

    it('cleanup() 應呼叫 topologyManager.cleanup()', async () => {
      await manager.initialize();
      await manager.cleanup();
      expect(mockTopologyManager.cleanup).toHaveBeenCalledTimes(1);
    });
  });

  // ── Spec 009 §4.7：協議版本不合事件 ──────────────────────────────────────

  describe('onProtocolMismatch（Spec 009）', () => {
    it('鄰居 GOSSIP_HELLO 版本不合 → 事件上拋；同 peer 只通知一次', async () => {
      let fireMismatch: (() => void) | null = null;
      const neighbor = {
        getId: vi.fn().mockReturnValue('peer-1'),
        getState: vi.fn().mockReturnValue('connected'),
        send: vi.fn().mockResolvedValue(undefined),
        sendDigest: vi.fn().mockResolvedValue(undefined),
        onMessage: vi.fn(),
        onDigest: vi.fn(),
        onEphemeral: vi.fn(),
        onProtocolMismatch: vi.fn().mockImplementation((cb: () => void) => {
          fireMismatch = cb;
          return () => {};
        }),
      };
      mockTopologyManager.getNeighbors.mockReturnValue([neighbor]);

      await manager.initialize();
      const events: Array<{ peerId: string }> = [];
      manager.onProtocolMismatch((info) => events.push(info));

      vi.advanceTimersByTime(2000); // 掃描器接線
      expect(fireMismatch).not.toBeNull();
      fireMismatch!();
      fireMismatch!(); // 重複觸發
      expect(events).toEqual([{ peerId: 'peer-1' }]); // 每 peer 至多一次

      mockTopologyManager.getNeighbors.mockReturnValue([]);
    });
  });
});

// ── Spec 012 Q2：交換逾時衍生與 waitForSendKey ───────────────────────────────
describe('Spec 012 Q2：交換逾時與送出金鑰等待', () => {
  type Internals = {
    initialized: boolean;
    keyCoordinator: object | null;
    messageHandler: { hasSendKey: () => boolean } | null;
    keyxStartedAt: number | null;
  };
  function rig(m: MeshGossipManager, over: Partial<Internals>): void {
    Object.assign(m as unknown as Internals, over);
  }

  it('exchanging 逾時（>60s）仍無鑰 → 衍生為 plaintext（fail-visible）', () => {
    const m = new MeshGossipManager('room-t', 'uid-t');
    rig(m, {
      initialized: true,
      keyCoordinator: {},
      messageHandler: { hasSendKey: () => false },
      keyxStartedAt: Date.now() - 61_000,
    });
    expect(m.getEncryptionState()).toBe('plaintext');
  });

  it('exchanging 未逾時 → 維持 exchanging；金鑰就緒 → encrypted（逾時亦恢復）', () => {
    const m = new MeshGossipManager('room-t', 'uid-t');
    rig(m, {
      initialized: true,
      keyCoordinator: {},
      messageHandler: { hasSendKey: () => false },
      keyxStartedAt: Date.now(),
    });
    expect(m.getEncryptionState()).toBe('exchanging');
    // 金鑰事後到位：即使逾時線已過，衍生值回 encrypted（狀態可恢復）
    rig(m, {
      messageHandler: { hasSendKey: () => true },
      keyxStartedAt: Date.now() - 120_000,
    });
    expect(m.getEncryptionState()).toBe('encrypted');
  });

  it('waitForSendKey：金鑰於等待中就緒 → true（hold 自動補送的原語）', async () => {
    const m = new MeshGossipManager('room-t', 'uid-t');
    let ready = false;
    rig(m, {
      initialized: true,
      keyCoordinator: {},
      messageHandler: { hasSendKey: () => ready },
      keyxStartedAt: Date.now(),
    });
    setTimeout(() => { ready = true; }, 300);
    await expect(m.waitForSendKey()).resolves.toBe(true);
  });

  it('waitForSendKey：已逾時且無鑰 → 立即 false；協調未啟動 → 立即 false', async () => {
    const m = new MeshGossipManager('room-t', 'uid-t');
    rig(m, {
      initialized: true,
      keyCoordinator: {},
      messageHandler: { hasSendKey: () => false },
      keyxStartedAt: Date.now() - 61_000,
    });
    await expect(m.waitForSendKey()).resolves.toBe(false);
    rig(m, { keyxStartedAt: null });
    await expect(m.waitForSendKey()).resolves.toBe(false);
  });
});
