/**
 * Spec 020：ready 截止的兩段式判準（進展寬限）。
 *
 * 修前：到期即盲砍。rejoin 門檻 15s 與實測握手 13-15s 幾無餘裕 → 誤殺差最後一哩的
 * 連線 → 再走一輪握手吃掉使用者感知窗（rejoin 8 輪 1 紅根因）。
 * 修後三條路徑：
 * (a) 無進展（bus 未建、pc 未連）→ 到期即 reject（現狀不變，保住快速重試）
 * (b) 有進展但未 open → 授予一次寬限；寬限內 open 則成功
 * (c) 有進展但寬限亦逾時 → reject（不無限等）
 *
 * @vitest-environment node
 */
import { describe, it, expect, vi, afterEach } from 'vitest';

/** 可控的假 P2PManager：測試逐步推進 bus 與 pc 狀態 */
const fake = {
  bus: null as null | { getReadyState: () => string },
  pcState: 'connecting' as string,
};

vi.mock('../../src/core/p2p/P2PManager', () => ({
  P2PManager: class {
    async initialize(): Promise<void> {}
    getChannelBus() {
      return fake.bus;
    }
    getConnectionManager() {
      return { getState: () => fake.pcState };
    }
    async close(): Promise<void> {}
    onProtocolMismatch() {
      return () => {};
    }
  },
}));
vi.mock('../../src/core/p2p/P2PChannelBus', () => ({ P2PChannelBus: class {} }));

import {
  MeshConnection,
  REJOIN_READY_TIMEOUT_MS,
  READY_GRACE_MS,
} from '../../src/core/mesh/MeshConnection';

function makeConn(): MeshConnection {
  return new MeshConnection('room-g', 'uid-a', 'uid-b', 'user-b', true, REJOIN_READY_TIMEOUT_MS);
}
/** 最小 bus 樁：成功路徑會 subscribe 各 ns 並送 GOSSIP_HELLO */
const busStub = (state: string) => ({
  getReadyState: () => state,
  subscribe: () => () => {},
  send: async () => {},
});
const openBus = busStub('open');
const connectingBus = busStub('connecting');

describe('Spec 020：ready 進展寬限', () => {
  afterEach(() => {
    fake.bus = null;
    fake.pcState = 'connecting';
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('(a) 無進展：到期即失敗，不授予寬限（快速重試語義不變）', async () => {
    vi.useFakeTimers();
    const conn = makeConn();
    const p = expect(conn.waitForReady()).rejects.toThrow(/not ready/);
    await vi.advanceTimersByTimeAsync(REJOIN_READY_TIMEOUT_MS + 500);
    await p;
  });

  it('(b) 有進展（bus 已建、未 open）：授予寬限，寬限內 open 則成功', async () => {
    vi.useFakeTimers();
    const conn = makeConn();
    const ready = conn.waitForReady();
    fake.bus = connectingBus; // signaling 完成、DataChannel 尚未 open
    await vi.advanceTimersByTimeAsync(REJOIN_READY_TIMEOUT_MS + 500); // 修前此刻已 reject
    fake.bus = openBus; // 差最後一哩，於寬限內開通
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(ready).resolves.toBeUndefined();
  });

  it('(c) 有進展但寬限亦逾時：仍失敗（不無限等），錯誤訊息標記 grace', async () => {
    vi.useFakeTimers();
    const conn = makeConn();
    const p = expect(conn.waitForReady()).rejects.toThrow(/grace/);
    fake.pcState = 'connected'; // 另一種進展訊號
    await vi.advanceTimersByTimeAsync(REJOIN_READY_TIMEOUT_MS + READY_GRACE_MS + 1_000);
    await p;
  });
});
