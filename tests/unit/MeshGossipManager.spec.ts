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
    manager = new MeshGossipManager('room-xyz');
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
});
