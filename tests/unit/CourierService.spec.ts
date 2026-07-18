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
import {
  CourierServer,
  CourierClient,
  COURIER_NS,
  CourierMsgType,
  buildRoomStore,
  runCourierBackup,
} from '../../src/core/relay/CourierService';
import { CourierStore, DEFAULT_COURIER_CONFIG } from '../../src/core/relay/CourierStore';
import { signTombstone, senderIdFromPubKey } from '../../src/core/relay/TombstoneCrypto';
import { ecdsaSigner } from '../../src/core/relay/CourierReceipts';
import { arrayBufferToBase64 } from '../../src/utils/crypto';
import type { CourierBus, CourierBackupDeps, CourierCreditConfig, MemberCreditConfig } from '../../src/core/relay/CourierService';
import type { P2PEnvelope, GossipMessage } from '../../src/types';
import { enc } from './_courierFixtures';

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
    content: enc('secret'),
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

    const ack = await client.deposit(rec({ seq: 1, content: enc('hello') }));
    expect(ack.accepted).toBe(true);
    await client.deposit(rec({ seq: 2, content: enc('world') }));

    const pulled = await client.pull('r1');
    expect(pulled).toHaveLength(2);
    expect(pulled.map((m) => m.content).sort()).toEqual([enc('hello'), enc('world')].sort());
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
    const ack = await client.deposit(rec({ content: enc('way-too-long-ciphertext'), signature: '' }));
    expect(ack).toEqual({ accepted: false, reason: 'record-too-large' });
  });

  it('未知 envelope 版本不得當作 v1 寄存', async () => {
    const [memberBus, courierBus] = linkedBuses();
    const store = new CourierStore(DEFAULT_COURIER_CONFIG, () => 1000);
    new CourierServer(courierBus, store, 'c').start();

    await memberBus.send({
      v: 2, ns: COURIER_NS, type: CourierMsgType.DEPOSIT,
      id: 'future-deposit', ts: 1000, from: 'future-member', payload: rec(),
    });
    expect(store.stats().recordCount).toBe(0);
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

describe('CourierService — anti-entropy 對帳（reconcile 雙向）', () => {
  it('信使有、成員缺 → 補給成員；成員有、信使缺 → 回推信使（一輪收斂）', async () => {
    const [memberBus, courierBus] = linkedBuses();
    const store = new CourierStore(DEFAULT_COURIER_CONFIG, () => 1000);
    const server = new CourierServer(courierBus, store, 'courier');
    const client = new CourierClient(memberBus, 'member');
    server.start();
    client.start();

    // 信使先有 A（別的成員寄存過）。
    const A = rec({ senderId: 'sA', seq: 1, content: enc('A'), messageId: 'A' });
    store.deposit(A);

    // 成員本地有 B（信使沒有）。成員缺 A。
    const B = rec({ senderId: 'sB', seq: 1, content: enc('B'), messageId: 'B' });
    const localStore = buildRoomStore([B]);
    const received: GossipMessage[] = [];

    const res = await client.reconcile('r1', localStore, new Map(), (m) => received.push(m));

    // 方向一：成員收到 A。
    expect(res.received).toBe(1);
    expect(received.map((m) => m.messageId)).toEqual(['A']);
    // 方向二：成員把 B 回推信使 → 信使現在兩筆都有。
    expect(res.pushed).toBe(1);
    const courierHas = store.serveRoom('r1').map((m) => m.messageId).sort();
    expect(courierHas).toEqual(['A', 'B']);
  });

  it('雙方已一致 → 不補不推（無多餘傳輸）', async () => {
    const [memberBus, courierBus] = linkedBuses();
    const store = new CourierStore(DEFAULT_COURIER_CONFIG, () => 1000);
    const server = new CourierServer(courierBus, store, 'courier');
    const client = new CourierClient(memberBus, 'member');
    server.start();
    client.start();
    const A = rec({ senderId: 'sA', seq: 1, messageId: 'A' });
    store.deposit(A);
    const res = await client.reconcile('r1', buildRoomStore([A]), new Map(), () => {});
    expect(res).toEqual({ received: 0, pushed: 0 });
  });

  it('成員缺中間 seq（missing 洞）→ 只補該洞', async () => {
    const [memberBus, courierBus] = linkedBuses();
    const store = new CourierStore(DEFAULT_COURIER_CONFIG, () => 1000);
    const server = new CourierServer(courierBus, store, 'courier');
    const client = new CourierClient(memberBus, 'member');
    server.start();
    client.start();
    // 信使有 sA 的 seq 1,2,3；成員只有 1,3（缺 2）。
    store.deposit(rec({ senderId: 'sA', seq: 1, messageId: 'a1' }));
    store.deposit(rec({ senderId: 'sA', seq: 2, messageId: 'a2' }));
    store.deposit(rec({ senderId: 'sA', seq: 3, messageId: 'a3' }));
    const local = buildRoomStore([
      rec({ senderId: 'sA', seq: 1, messageId: 'a1' }),
      rec({ senderId: 'sA', seq: 3, messageId: 'a3' }),
    ]);
    const received: GossipMessage[] = [];
    const res = await client.reconcile('r1', local, new Map(), (m) => received.push(m));
    expect(received.map((m) => m.messageId)).toEqual(['a2']); // 只補洞
    expect(res.pushed).toBe(0); // 信使不缺任何
  });
});

describe('runCourierBackup — 成員背景備份一輪（app 觸發）', () => {
  /** 造一個「真對接 courier server」的 openClient，讓 backup 走完整 reconcile。 */
  function realBackupSetup(courierStore: CourierStore) {
    const [memberBus, courierBus] = linkedBuses();
    new CourierServer(courierBus, courierStore, 'courier').start();
    const openClient = async (courierUid: string): Promise<CourierClient> => {
      void courierUid;
      const c = new CourierClient(memberBus, 'member');
      c.start();
      return c;
    };
    return { openClient };
  }

  it('備份我持有的每一房：推信使缺的、收信使有我缺的並落地', async () => {
    const courierStore = new CourierStore(DEFAULT_COURIER_CONFIG, () => 1000);
    // 信使先有 room1 的 A（別人存過）；我 room1 有 B、room2 有 C。
    courierStore.deposit(rec({ roomId: 'room1', senderId: 'sA', seq: 1, messageId: 'A' }));

    const local: Record<string, GossipMessage[]> = {
      room1: [rec({ roomId: 'room1', senderId: 'sB', seq: 1, messageId: 'B' })],
      room2: [rec({ roomId: 'room2', senderId: 'sC', seq: 1, messageId: 'C' })],
    };
    const saved: Array<{ roomId: string; id: string }> = [];
    const deps: CourierBackupDeps = {
      listRooms: async () => ['room1', 'room2'],
      loadRoom: async (roomId) => ({ records: local[roomId] ?? [], floors: [] }),
      saveRecord: async (roomId, m) => { saved.push({ roomId, id: m.messageId! }); },
      discoverCourierUids: async () => ['courier-uid'],
      ...realBackupSetup(courierStore),
    };

    const summary = await runCourierBackup(deps);

    expect(summary.rooms).toBe(2);
    expect(summary.received).toBe(1); // room1 的 A 補給我
    expect(summary.pushed).toBe(2);   // room1 的 B + room2 的 C 推給信使
    // A 落地到本地 room1
    expect(saved).toEqual([{ roomId: 'room1', id: 'A' }]);
    // 信使現在有 room1: A+B、room2: C
    expect(courierStore.serveRoom('room1').map((m) => m.messageId).sort()).toEqual(['A', 'B']);
    expect(courierStore.serveRoom('room2').map((m) => m.messageId)).toEqual(['C']);
  });

  it('沒有房要備份 → 不連任何信使（回 0）', async () => {
    const deps: CourierBackupDeps = {
      listRooms: async () => [],
      loadRoom: vi.fn(),
      saveRecord: vi.fn(),
      discoverCourierUids: vi.fn(),
      openClient: vi.fn(),
    };
    const summary = await runCourierBackup(deps);
    expect(summary).toEqual({ rooms: 0, received: 0, pushed: 0 });
    expect(deps.discoverCourierUids).not.toHaveBeenCalled(); // 沒資料就不發現
  });

  it('沒有可用信使 → 不動作（回 0）', async () => {
    const deps: CourierBackupDeps = {
      listRooms: async () => ['room1'],
      loadRoom: async () => ({ records: [], floors: [] }),
      saveRecord: vi.fn(),
      discoverCourierUids: async () => [],
      openClient: vi.fn(),
    };
    const summary = await runCourierBackup(deps);
    expect(summary).toEqual({ rooms: 0, received: 0, pushed: 0 });
    expect(deps.openClient).not.toHaveBeenCalled();
  });

  it('第一個候選不可達（openClient 回 null）→ 換下一個候選', async () => {
    const courierStore = new CourierStore(DEFAULT_COURIER_CONFIG, () => 1000);
    const { openClient: liveOpen } = realBackupSetup(courierStore);
    const tried: string[] = [];
    const deps: CourierBackupDeps = {
      listRooms: async () => ['room1'],
      loadRoom: async () => ({ records: [rec({ roomId: 'room1', senderId: 'sX', seq: 1, messageId: 'X' })], floors: [] }),
      saveRecord: async () => {},
      discoverCourierUids: async () => ['stale-uid', 'live-uid'],
      openClient: async (courierUid) => {
        tried.push(courierUid);
        if (courierUid === 'stale-uid') return null; // 陳舊：連不上
        return liveOpen(courierUid);
      },
    };
    const summary = await runCourierBackup(deps);
    expect(tried).toEqual(['stale-uid', 'live-uid']); // 略過陳舊、用 live
    expect(summary.pushed).toBe(1);
    expect(courierStore.serveRoom('room1').map((m) => m.messageId)).toEqual(['X']);
  });

  it('單一房 reconcile 拋錯 → 該房略過，其他房照常（best-effort）', async () => {
    const courierStore = new CourierStore(DEFAULT_COURIER_CONFIG, () => 1000);
    const deps: CourierBackupDeps = {
      listRooms: async () => ['bad', 'good'],
      loadRoom: async (roomId) => {
        if (roomId === 'bad') throw new Error('load boom');
        return { records: [rec({ roomId: 'good', senderId: 'sG', seq: 1, messageId: 'G' })], floors: [] };
      },
      saveRecord: async () => {},
      discoverCourierUids: async () => ['courier-uid'],
      ...realBackupSetup(courierStore),
    };
    const summary = await runCourierBackup(deps);
    expect(summary.rooms).toBe(1); // 只有 good 成功
    expect(courierStore.serveRoom('good').map((m) => m.messageId)).toEqual(['G']);
  });
});

describe('CourierService — tombstone 真房籍簽章（預設驗證器）', () => {
  async function makeMember() {
    const kp = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
    const pubKey = arrayBufferToBase64(await crypto.subtle.exportKey('spki', kp.publicKey));
    const senderId = await senderIdFromPubKey(pubKey);
    return { privateKey: kp.privateKey, pubKey, senderId };
  }

  it('貢獻過紀錄的成員真簽墓碑 → 信使盲驗通過、刪整房', async () => {
    const [memberBus, courierBus] = linkedBuses();
    const store = new CourierStore(DEFAULT_COURIER_CONFIG, () => 1000);
    new CourierServer(courierBus, store, 'courier').start(); // 無 override → 用預設真驗證
    const client = new CourierClient(memberBus, 'member');
    client.start();

    const m = await makeMember();
    // 成員對 room1 貢獻過一筆紀錄（senderId = 其 pubKey 導出）→ 房籍成立。
    store.deposit(rec({ roomId: 'room1', senderId: m.senderId, seq: 1, messageId: 'r1' }));
    expect(store.serveRoom('room1')).toHaveLength(1);

    const tomb = await signTombstone('room1', m.privateKey, m.pubKey);
    const freed = await client.tombstone('room1', tomb);
    expect(freed).toBeGreaterThan(0);
    expect(store.serveRoom('room1')).toHaveLength(0); // 刪光
  });

  it('非成員（沒對該房貢獻過）真簽墓碑 → 拒（房籍不成立）', async () => {
    const [memberBus, courierBus] = linkedBuses();
    const store = new CourierStore(DEFAULT_COURIER_CONFIG, () => 1000);
    new CourierServer(courierBus, store, 'courier').start();
    const client = new CourierClient(memberBus, 'member');
    client.start();

    const insider = await makeMember();
    const outsider = await makeMember();
    store.deposit(rec({ roomId: 'room1', senderId: insider.senderId, seq: 1, messageId: 'r1' }));

    // outsider 用自己的真金鑰簽（簽章有效），但沒對 room1 貢獻過 → senderId 不在 store。
    const tomb = await signTombstone('room1', outsider.privateKey, outsider.pubKey);
    const freed = await client.tombstone('room1', tomb);
    expect(freed).toBe(0);
    expect(store.serveRoom('room1')).toHaveLength(1); // 不刪
  });
});

describe('CourierService — 計量（共簽收據 → 計點，ADR-0022）', () => {
  async function makeNode() {
    const kp = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
    const pubKey = arrayBufferToBase64(await crypto.subtle.exportKey('spki', kp.publicKey));
    const nodeId = await senderIdFromPubKey(pubKey);
    return { pubKey, nodeId, sign: ecdsaSigner(kp.privateKey) };
  }

  /** 輪詢等條件成立（收據交換是多步 async crypto，microtask 不夠）。 */
  async function waitFor(cond: () => boolean, ms = 3000) {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      if (cond()) return;
      await new Promise((r) => setTimeout(r, 10));
    }
  }
  /** 固定等一小段（用於「確認什麼都沒發生」的否定斷言）。 */
  async function settle(ms = 300) {
    await new Promise((r) => setTimeout(r, ms));
  }

  it('成員寄存 → 信使起草收據 → 成員回簽 → 信使驗簽後計點（bytes 正確）', async () => {
    const [memberBus, courierBus] = linkedBuses();
    const store = new CourierStore(DEFAULT_COURIER_CONFIG, () => 1000);
    const courier = await makeNode();
    const member = await makeNode();
    const credited: Array<{ requesterNodeId: string; bytes: number }> = [];
    const courierCredit: CourierCreditConfig = {
      nodeId: courier.nodeId, pubKey: courier.pubKey, sign: courier.sign,
      onCredit: (requesterNodeId, bytes) => { credited.push({ requesterNodeId, bytes }); },
    };
    const memberCredit: MemberCreditConfig = { nodeId: member.nodeId, pubKey: member.pubKey, sign: member.sign };

    const server = new CourierServer(courierBus, store, 'courier-uid', undefined, courierCredit);
    server.start();
    const client = new CourierClient(memberBus, 'member-uid', 3000, memberCredit);
    client.start(); // 送 IDENTIFY
    await settle(50); // 等 IDENTIFY 抵達信使

    // 寄存兩筆（各有位元組）。
    await client.deposit(rec({ roomId: 'r1', senderId: 'sX', seq: 1, content: enc('aaaa'), signature: 'ss' }));
    await client.deposit(rec({ roomId: 'r1', senderId: 'sX', seq: 2, content: enc('bbbb'), signature: 'ss' }));

    // 信使發起計量一輪。
    await server.claimCredit();
    await waitFor(() => credited.length === 1);

    expect(credited).toHaveLength(1);
    expect(credited[0]!.requesterNodeId).toBe(member.nodeId);
    // bytes == 兩筆 content+signature 的 UTF-8 位元組總和（>0）。
    expect(credited[0]!.bytes).toBeGreaterThan(0);
  });

  it('無成員回簽（成員不參與計量）→ 信使不計點', async () => {
    const [memberBus, courierBus] = linkedBuses();
    const store = new CourierStore(DEFAULT_COURIER_CONFIG, () => 1000);
    const courier = await makeNode();
    const credited: number[] = [];
    const server = new CourierServer(courierBus, store, 'courier-uid', undefined, {
      nodeId: courier.nodeId, pubKey: courier.pubKey, sign: courier.sign,
      onCredit: (_r, bytes) => { credited.push(bytes); },
    });
    server.start();
    // 成員不帶 credit config → 不 IDENTIFY、不回簽。
    const client = new CourierClient(memberBus, 'member-uid', 3000);
    client.start();
    await client.deposit(rec({ roomId: 'r1', senderId: 'sX', seq: 1 }));
    await server.claimCredit(); // 沒 requester 身分 → 不起草
    await settle();
    expect(credited).toHaveLength(0);
  });

  it('成員 approve 拒絕（bytes 不合理）→ 不回簽 → 信使不計點', async () => {
    const [memberBus, courierBus] = linkedBuses();
    const store = new CourierStore(DEFAULT_COURIER_CONFIG, () => 1000);
    const courier = await makeNode();
    const member = await makeNode();
    const credited: number[] = [];
    const server = new CourierServer(courierBus, store, 'courier-uid', undefined, {
      nodeId: courier.nodeId, pubKey: courier.pubKey, sign: courier.sign,
      onCredit: (_r, bytes) => { credited.push(bytes); },
    });
    server.start();
    const client = new CourierClient(memberBus, 'member-uid', 3000, {
      nodeId: member.nodeId, pubKey: member.pubKey, sign: member.sign,
      approve: () => false, // 一律拒簽
    });
    client.start();
    await settle(50);
    await client.deposit(rec({ roomId: 'r1', senderId: 'sX', seq: 1 }));
    await server.claimCredit();
    await settle();
    expect(credited).toHaveLength(0);
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
