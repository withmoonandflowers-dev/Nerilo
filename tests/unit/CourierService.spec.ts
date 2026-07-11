/**
 * CourierService 整合測試（ADR-0023 P4-C.2）——寄存協議在「對接 bus」上端到端跑：
 * 成員 deposit → 信使存進 CourierStore → 成員回線 pull 原樣取回；tombstone 驗章即刪。
 *
 * 用 LinkedBus 模擬 2-peer DataChannel：一端 send 只送達「另一端」的 handler（不回放自己），
 * 與 P2PChannelBus 的實際行為一致 → 無需真 WebRTC 即可驗協議正確性。
 *
 * @vitest-environment node
 */
import { describe, it, expect, vi } from 'vitest';
import { CourierServer, CourierClient, COURIER_NS } from '../../src/core/relay/CourierService';
import { CourierStore, DEFAULT_COURIER_CONFIG } from '../../src/core/relay/CourierStore';
import type { CourierBus } from '../../src/core/relay/CourierService';
import type { P2PEnvelope, GossipMessage } from '../../src/types';

/** 一端：對外 send 交給 partner 的 handlers；自己 subscribe 收 partner 送來的。 */
class BusEnd implements CourierBus {
  private handlers = new Map<string, Set<(env: P2PEnvelope) => void | Promise<void>>>();
  partner!: BusEnd;

  subscribe(ns: string, handler: (env: P2PEnvelope) => void | Promise<void>): () => void {
    if (!this.handlers.has(ns)) this.handlers.set(ns, new Set());
    this.handlers.get(ns)!.add(handler);
    return () => this.handlers.get(ns)?.delete(handler);
  }

  async send(env: P2PEnvelope): Promise<void> {
    // 送達對端；用 microtask 模擬非同步傳輸（避免同步遞迴）。
    await Promise.resolve();
    await this.partner.deliver(env);
  }

  private async deliver(env: P2PEnvelope): Promise<void> {
    for (const h of this.handlers.get(env.ns) ?? []) await h(env);
  }
}

function linkedBuses(): [BusEnd, BusEnd] {
  const a = new BusEnd();
  const b = new BusEnd();
  a.partner = b;
  b.partner = a;
  return [a, b];
}

function rec(over: Partial<GossipMessage> = {}): GossipMessage {
  return {
    roomId: 'r1',
    senderId: 's1',
    pubKey: 'pk',
    seq: 1,
    timestamp: 1000,
    content: 'ENC:secret',
    ttl: 3,
    signature: 'SIG',
    ...over,
  };
}

describe('CourierService — 寄存/取回端到端', () => {
  it('member deposit → courier 存 → member pull 原樣取回', async () => {
    const [memberBus, courierBus] = linkedBuses();
    const store = new CourierStore(DEFAULT_COURIER_CONFIG, () => 1000);
    const server = new CourierServer(courierBus, store, 'courier-node');
    const client = new CourierClient(memberBus, 'member-uid');
    server.start();
    client.start();

    const ack = await client.deposit(rec({ seq: 1, content: 'ENC:hello' }));
    expect(ack.accepted).toBe(true);
    await client.deposit(rec({ seq: 2, content: 'ENC:world' }));

    const pulled = await client.pull('r1');
    expect(pulled).toHaveLength(2);
    expect(pulled.map((m) => m.content).sort()).toEqual(['ENC:hello', 'ENC:world']);
    // 信使真的存進了 store（盲存：content 未被改動）
    expect(store.stats().recordCount).toBe(2);
  });

  it('pull 未知房 → 空陣列', async () => {
    const [memberBus, courierBus] = linkedBuses();
    const server = new CourierServer(courierBus, new CourierStore(DEFAULT_COURIER_CONFIG, () => 1000), 'c');
    const client = new CourierClient(memberBus, 'm');
    server.start();
    client.start();
    expect(await client.pull('ghost')).toEqual([]);
  });

  it('deposit 超單筆上限 → ack 帶拒收原因', async () => {
    const [memberBus, courierBus] = linkedBuses();
    const store = new CourierStore({ ...DEFAULT_COURIER_CONFIG, maxRecordBytes: 5 }, () => 1000);
    const server = new CourierServer(courierBus, store, 'c');
    const client = new CourierClient(memberBus, 'm');
    server.start();
    client.start();
    const ack = await client.deposit(rec({ content: 'way-too-long-ciphertext', signature: '' }));
    expect(ack).toEqual({ accepted: false, reason: 'record-too-large' });
  });
});

describe('CourierService — tombstone', () => {
  it('驗章過 → 刪整房、回傳釋放位元組', async () => {
    const [memberBus, courierBus] = linkedBuses();
    const store = new CourierStore(DEFAULT_COURIER_CONFIG, () => 1000);
    const verify = vi.fn().mockResolvedValue(true);
    const server = new CourierServer(courierBus, store, 'c', verify);
    const client = new CourierClient(memberBus, 'm');
    server.start();
    client.start();

    await client.deposit(rec({ seq: 1 }));
    await client.deposit(rec({ seq: 2 }));
    const freed = await client.tombstone('r1', { sig: 'membership-proof' });
    expect(freed).toBeGreaterThan(0);
    expect(verify).toHaveBeenCalledWith('r1', { sig: 'membership-proof' });
    expect(await client.pull('r1')).toEqual([]);
  });

  it('驗章不過（預設）→ 不刪、freed=0', async () => {
    const [memberBus, courierBus] = linkedBuses();
    const store = new CourierStore(DEFAULT_COURIER_CONFIG, () => 1000);
    const server = new CourierServer(courierBus, store, 'c'); // 預設 verifyTombstone=拒
    const client = new CourierClient(memberBus, 'm');
    server.start();
    client.start();
    await client.deposit(rec({ seq: 1 }));
    const freed = await client.tombstone('r1', { forged: true });
    expect(freed).toBe(0);
    expect(await client.pull('r1')).toHaveLength(1);
  });
});

describe('CourierService — 韌性', () => {
  it('request 逾時 → reject（信使不回時不永久卡住）', async () => {
    const [memberBus] = linkedBuses(); // 不啟 server → 無人回覆
    const client = new CourierClient(memberBus, 'm', 30); // 30ms 逾時
    client.start();
    await expect(client.pull('r1')).rejects.toThrow(/timeout/);
  });

  it('server 忽略 from==self 的封包（bus 回放防護）', async () => {
    const [memberBus, courierBus] = linkedBuses();
    const store = new CourierStore(DEFAULT_COURIER_CONFIG, () => 1000);
    const server = new CourierServer(courierBus, store, 'courier-self');
    server.start();
    // 從對端送一個「from 偽裝成 courier 自己」的 deposit → server 應忽略、不存。
    await memberBus.send({
      v: 1, ns: COURIER_NS, type: 'deposit', id: 'x', ts: 0,
      from: 'courier-self', payload: rec({ seq: 99 }),
    });
    expect(store.stats().recordCount).toBe(0);
  });
});
