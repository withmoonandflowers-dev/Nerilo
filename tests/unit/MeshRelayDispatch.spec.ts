/**
 * 鄰居訊息分派的現況釘子（characterization，洋蔥棧 PARK 前置）。
 *
 * 要改的是 `MeshGossipManager.setupNeighborMessageHandlers()` 裡的分派：
 * 目前 `type === 'relay:forward'` 的訊息會被交給 RelayManager 然後 return，
 * **不會**往下餵 messageHandler。PARK 洋蔥棧會拿掉 RelayManager，
 * 若順手把整個分支刪掉，這類訊息就會落到 messageHandler（它預期的是 gossip 訊息）。
 *
 * 這支測試釘住兩件事，改動後必須一字不改仍綠：
 *   1. relay:forward 不得進 messageHandler
 *   2. 一般 gossip 訊息必須進 messageHandler
 * @vitest-environment node
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mockMessageHandler = {
  sendMessage: vi.fn().mockResolvedValue(undefined),
  onMessage: vi.fn().mockReturnValue(() => {}),
  hydrate: vi.fn().mockResolvedValue(undefined),
  sendDigestTo: vi.fn().mockResolvedValue(undefined),
  handleReceivedMessage: vi.fn().mockResolvedValue(undefined),
  handleDigest: vi.fn().mockResolvedValue(undefined),
};

vi.mock('../../src/core/mesh/GossipMessageHandler', () => ({
  GossipMessageHandler: vi.fn().mockImplementation(() => mockMessageHandler),
}));
vi.mock('../../src/config/firebase', () => ({ auth: { currentUser: null }, db: {} }));

import { MeshGossipManager } from '../../src/core/mesh/MeshGossipManager';

/**
 * 假鄰居：形狀對齊 MeshConnection 被實際用到的部分（getId/onMessage/onDigest）。
 * 其餘方法刻意不實作——產品碼對它們做 feature-detect，正好驗證那些 typeof 檢查有效。
 */
function makeNeighbor(peerId: string) {
  let handler: ((m: unknown) => unknown) | null = null;
  return {
    peerId,
    conn: {
      getId: () => peerId,
      onMessage: (cb: (m: unknown) => unknown) => {
        handler = cb;
      },
      onDigest: () => {},
      onEphemeral: () => {},
      getState: () => 'connected',
    },
    push: (m: unknown) => handler?.(m),
    get wired() {
      return handler !== null;
    },
  };
}

describe('鄰居訊息分派現況釘子（洋蔥棧 PARK 前置）', () => {
  let manager: MeshGossipManager;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    manager = new MeshGossipManager('room-1', 'uid-local');
  });

  afterEach(async () => {
    await manager.cleanup().catch(() => {});
    vi.useRealTimers();
  });

  it('C1 relay:forward 不會被餵給 messageHandler（分派早退）', async () => {
    const n = makeNeighbor('peer-a');
    // 直接把假拓撲與 handler 塞進去，繞開真實連線建立
    (manager as any).messageHandler = mockMessageHandler;
    (manager as any).topologyManager = { getNeighbors: () => [n.conn], getNeighborCount: () => 1 };
    (manager as any).setupNeighborMessageHandlers();
    vi.advanceTimersByTime(2100); // 接線發生在 2 秒掃描迴圈裡

    expect(n.wired).toBe(true);
    await n.push({ type: 'relay:forward', payload: 'x' });
    expect(mockMessageHandler.handleReceivedMessage).not.toHaveBeenCalled();
  });

  it('C2 一般 gossip 訊息必須進 messageHandler', async () => {
    const n = makeNeighbor('peer-b');
    (manager as any).messageHandler = mockMessageHandler;
    (manager as any).topologyManager = { getNeighbors: () => [n.conn], getNeighborCount: () => 1 };
    (manager as any).setupNeighborMessageHandlers();
    vi.advanceTimersByTime(2100);

    const msg = { type: 'chat', senderId: 's1', seq: 1 };
    await n.push(msg);
    expect(mockMessageHandler.handleReceivedMessage).toHaveBeenCalledWith(msg, 'peer-b');
  });
});
