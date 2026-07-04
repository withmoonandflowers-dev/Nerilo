/**
 * RelayCoordinator 測試（ADR-0021 整合層）
 *
 * 驗證兩件現在真實可用的事：
 *   1. 中繼賺點事件 → 流進真實 CreditEconomy 餘額
 *   2. attachTransport 把 send/delivery 注入 RelayManager
 *
 * 不測 overlay/實際轉發——那需要全域網路 + 多節點，尚未建立（見 RelayCoordinator 註解）。
 *
 * @vitest-environment node
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { RelayCoordinator } from '../../src/core/relay/RelayCoordinator';
import { CreditEconomy } from '../../src/core/incentive/CreditEconomy';
import type { RelayManager } from '../../src/core/relay/RelayManager';
import type { RelayEvent } from '../../src/core/relay/types';

function installLocalStorageStub(): void {
  const store = new Map<string, string>();
  (globalThis as Record<string, unknown>).localStorage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  };
}

/** 迷你假 RelayManager：只實作 Coordinator 用到的 on / setPeerSendFunction / onMessageDelivery */
function makeFakeRelay() {
  const handlers = new Map<string, (e: RelayEvent) => void>();
  return {
    setPeerSendFunction: vi.fn(),
    onMessageDelivery: vi.fn(),
    on: vi.fn((type: string, handler: (e: RelayEvent) => void) => {
      handlers.set(type, handler);
      return () => handlers.delete(type);
    }),
    /** 測試用：觸發事件 */
    emit(type: string, data: Record<string, unknown>) {
      handlers.get(type)?.({ type, timestamp: 0, data } as RelayEvent);
    },
  };
}

describe('RelayCoordinator', () => {
  let econ: CreditEconomy;

  beforeEach(() => {
    installLocalStorageStub();
    econ = new CreditEconomy();
    econ.init('alice');
  });

  afterEach(() => {
    econ.reset();
    delete (globalThis as Record<string, unknown>).localStorage;
  });

  it('中繼賺點事件 → 流進真實餘額', async () => {
    const relay = makeFakeRelay();
    const coord = new RelayCoordinator(relay as unknown as RelayManager, econ);
    coord.start();

    relay.emit('relay:credit-earned', { nodeId: 'alice', bytes: 10 * 1024 });
    await Promise.resolve(); // 等 recordRelayContribution 的 microtask

    // 初始 100 + (10*1 + 5) = 115
    expect((await econ.getBalance())!.balance).toBeCloseTo(115, 5);
    coord.stop();
  });

  it('bytes <= 0 不加點', async () => {
    const relay = makeFakeRelay();
    const coord = new RelayCoordinator(relay as unknown as RelayManager, econ);
    coord.start();

    relay.emit('relay:credit-earned', { nodeId: 'alice', bytes: 0 });
    await Promise.resolve();

    expect((await econ.getBalance())!.balance).toBe(100);
    coord.stop();
  });

  it('stop 後事件不再加點', async () => {
    const relay = makeFakeRelay();
    const coord = new RelayCoordinator(relay as unknown as RelayManager, econ);
    coord.start();
    coord.stop();

    relay.emit('relay:credit-earned', { nodeId: 'alice', bytes: 4 * 1024 });
    await Promise.resolve();

    expect((await econ.getBalance())!.balance).toBe(100);
  });

  it('attachTransport 注入 send/delivery 且標記已接', () => {
    const relay = makeFakeRelay();
    const coord = new RelayCoordinator(relay as unknown as RelayManager, econ);

    expect(coord.isTransportAttached()).toBe(false);
    const send = vi.fn();
    const deliver = vi.fn();
    coord.attachTransport(send, deliver);

    expect(relay.setPeerSendFunction).toHaveBeenCalledWith(send);
    expect(relay.onMessageDelivery).toHaveBeenCalledWith(deliver);
    expect(coord.isTransportAttached()).toBe(true);
  });

  it('useOverlay 建 overlay 並宣告自己可中繼', async () => {
    const { InMemoryRelayDirectory } = await import('../../src/core/relay/RelayDirectory');
    const relay = { ...makeFakeRelay(), registerPeer: vi.fn(), unregisterPeer: vi.fn() };
    const dir = new InMemoryRelayDirectory(30_000, () => 1000);
    const coord = new RelayCoordinator(relay as unknown as RelayManager, econ);

    const overlay = coord.useOverlay(dir, 'A', { reliability: 0.9 });
    await Promise.resolve(); // 等 announceSelf microtask
    expect(overlay).toBeDefined();
    expect((await dir.query()).map((e) => e.nodeId)).toContain('A');
  });
});
