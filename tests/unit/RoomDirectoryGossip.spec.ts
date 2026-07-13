/**
 * 房間目錄 P2P 廣播（去中心化大廳第一片）：
 *  - 廣告簽章：真 ECDSA 建/驗、竄改拒、冒名（nodeId 不綁 pubKey）拒、壞形狀拒。
 *  - 快取：同房取最新、TTL、未來時戳拒、per-node 防洪、總量帽、onChange。
 *  - attach：對接的假 bus 上，兩端 announce 即互見（驗簽後入快取），壞廣告靜默丟。
 */
import { describe, it, expect } from 'vitest';
import {
  buildRoomAdvert,
  verifyRoomAdvert,
  RoomAdvertCache,
  attachRoomDirectory,
  mergeAnnounceSet,
  ROOMDIR_NS,
  type RoomAdvert,
  type RoomDirBus,
} from '../../src/core/relay/RoomDirectoryGossip';
import { ecdsaSigner } from '../../src/core/relay/CourierReceipts';
import { senderIdFromPubKey } from '../../src/core/relay/TombstoneCrypto';
import { arrayBufferToBase64 } from '../../src/utils/crypto';

async function makeIdentity() {
  const kp = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const pubKey = arrayBufferToBase64(await crypto.subtle.exportKey('spki', kp.publicKey));
  const nodeId = await senderIdFromPubKey(pubKey);
  return { pubKey, nodeId, sign: ecdsaSigner(kp.privateKey) };
}

async function makeAdvert(
  id: Awaited<ReturnType<typeof makeIdentity>>,
  roomId: string,
  issuedAt = Date.now(),
  roomName = '測試房'
): Promise<RoomAdvert> {
  return buildRoomAdvert(
    { roomId, roomName, ownerUid: 'owner-1', participantCount: 1, issuedAt, nodeId: id.nodeId, pubKey: id.pubKey },
    id.sign
  );
}

describe('RoomAdvert 簽章', () => {
  it('建出的廣告驗簽通過', async () => {
    const a = await makeIdentity();
    expect(await verifyRoomAdvert(await makeAdvert(a, 'r1'))).toBe(true);
  });

  it('竄改欄位（roomName）→ 驗簽失敗', async () => {
    const a = await makeIdentity();
    const ad = await makeAdvert(a, 'r1');
    expect(await verifyRoomAdvert({ ...ad, roomName: '改名' })).toBe(false);
  });

  it('冒名（別人的 nodeId + 我的 pubKey/簽章）→ 拒', async () => {
    const a = await makeIdentity();
    const b = await makeIdentity();
    const forged = await buildRoomAdvert(
      { roomId: 'r1', roomName: 'x', ownerUid: 'o', participantCount: 1, issuedAt: Date.now(), nodeId: b.nodeId, pubKey: a.pubKey },
      a.sign
    );
    expect(await verifyRoomAdvert(forged)).toBe(false);
  });

  it('壞形狀（缺欄位/超長）→ 拒', async () => {
    const a = await makeIdentity();
    const ad = await makeAdvert(a, 'r1');
    expect(await verifyRoomAdvert({ ...ad, roomId: '' })).toBe(false);
    expect(await verifyRoomAdvert({ ...ad, roomName: 'x'.repeat(200) })).toBe(false);
    // @ts-expect-error 故意壞資料
    expect(await verifyRoomAdvert(null)).toBe(false);
  });
});

describe('RoomAdvertCache', () => {
  it('同房取最新；較舊的 no-op', async () => {
    const a = await makeIdentity();
    const now = 1_000_000;
    const cache = new RoomAdvertCache({ now: () => now });
    expect(cache.upsert(await makeAdvert(a, 'r1', now - 1000))).toBe(true);
    expect(cache.upsert(await makeAdvert(a, 'r1', now - 5000))).toBe(false); // 較舊
    expect(cache.upsert(await makeAdvert(a, 'r1', now - 500, '更新'))).toBe(true);
    expect(cache.list()[0].roomName).toBe('更新');
    expect(cache.size()).toBe(1);
  });

  it('TTL 過期會被修剪；到手即過期不收；未來時戳拒收', async () => {
    const a = await makeIdentity();
    let now = 1_000_000;
    const cache = new RoomAdvertCache({ ttlMs: 10_000, now: () => now });
    expect(cache.upsert(await makeAdvert(a, 'r1', now - 20_000))).toBe(false); // 已過期
    expect(cache.upsert(await makeAdvert(a, 'r2', now + 120_000))).toBe(false); // 未來
    expect(cache.upsert(await makeAdvert(a, 'r3', now))).toBe(true);
    now += 15_000; // 超過 TTL
    expect(cache.list()).toHaveLength(0);
  });

  it('per-node 防洪：同一廣告者最多 maxPerNode 房', async () => {
    const a = await makeIdentity();
    const now = 1_000_000;
    const cache = new RoomAdvertCache({ maxPerNode: 2, now: () => now });
    expect(cache.upsert(await makeAdvert(a, 'r1', now))).toBe(true);
    expect(cache.upsert(await makeAdvert(a, 'r2', now))).toBe(true);
    expect(cache.upsert(await makeAdvert(a, 'r3', now))).toBe(false); // 超帽
  });

  it('總量帽：滿了丟最舊；比最舊還舊的不收', async () => {
    const a = await makeIdentity();
    const b = await makeIdentity();
    const now = 1_000_000;
    const cache = new RoomAdvertCache({ maxTotal: 2, now: () => now });
    cache.upsert(await makeAdvert(a, 'r1', now - 3000));
    cache.upsert(await makeAdvert(a, 'r2', now - 2000));
    expect(cache.upsert(await makeAdvert(b, 'r3', now - 1000))).toBe(true); // 擠掉 r1
    expect(cache.list().map((x) => x.roomId).sort()).toEqual(['r2', 'r3']);
    expect(cache.upsert(await makeAdvert(b, 'r4', now - 9000))).toBe(false); // 比最舊還舊
  });

  it('onChange 在狀態改變時觸發', async () => {
    const a = await makeIdentity();
    const cache = new RoomAdvertCache();
    let fired = 0;
    cache.onChange(() => fired++);
    cache.upsert(await makeAdvert(a, 'r1'));
    expect(fired).toBe(1);
  });
});

describe('attachRoomDirectory（對接假 bus）', () => {
  /** 一對互通的假 bus：A send → B 的訂閱者收到，反之亦然。 */
  function busPair(): [RoomDirBus, RoomDirBus] {
    type H = (env: never) => void | Promise<void>;
    const handlers: [Map<string, H[]>, Map<string, H[]>] = [new Map(), new Map()];
    const make = (mine: 0 | 1): RoomDirBus => ({
      subscribe(ns, h) {
        const list = handlers[mine].get(ns) ?? [];
        list.push(h as H);
        handlers[mine].set(ns, list);
        return () => {
          const cur = handlers[mine].get(ns) ?? [];
          handlers[mine].set(ns, cur.filter((x) => x !== (h as H)));
        };
      },
      async send(env) {
        const other = mine === 0 ? 1 : 0;
        for (const h of handlers[other].get(env.ns) ?? []) await (h as (e: unknown) => unknown)(env);
      },
    });
    return [make(0), make(1)];
  }

  it('兩端 attach 後互見對方的（驗簽過的）廣告；壞簽章靜默丟', async () => {
    const a = await makeIdentity();
    const b = await makeIdentity();
    const [busA, busB] = busPair();
    const cacheA = new RoomAdvertCache();
    const cacheB = new RoomAdvertCache();
    const adA = await makeAdvert(a, 'room-a');
    const adBad = { ...(await makeAdvert(a, 'room-bad')), sig: 'AAAA' }; // 壞簽章
    const adB = await makeAdvert(b, 'room-b');

    const detachB = attachRoomDirectory({
      bus: busB, cache: cacheB, localUid: 'uid-b', announceIntervalMs: 0,
      getLocalAdverts: async () => [adB],
    });
    const detachA = attachRoomDirectory({
      bus: busA, cache: cacheA, localUid: 'uid-a', announceIntervalMs: 0,
      getLocalAdverts: async () => [adA, adBad],
    });
    await new Promise((r) => setTimeout(r, 50)); // announce 為 async fire-and-forget

    expect(cacheB.list().map((x) => x.roomId)).toEqual(['room-a']); // 壞的被丟
    expect(cacheA.list().map((x) => x.roomId)).toEqual(['room-b']);
    detachA();
    detachB();
  });

  it('detach 後不再收 announce', async () => {
    const a = await makeIdentity();
    const [busA, busB] = busPair();
    const cacheB = new RoomAdvertCache();
    const detachB = attachRoomDirectory({
      bus: busB, cache: cacheB, localUid: 'uid-b', announceIntervalMs: 0,
      getLocalAdverts: async () => [],
    });
    detachB();
    await busA.send({
      v: 1, ns: ROOMDIR_NS, type: 'ROOMDIR_ANNOUNCE', id: 'x', ts: Date.now(), from: 'uid-a',
      payload: { adverts: [await makeAdvert(a, 'r-late')] },
    });
    await new Promise((r) => setTimeout(r, 30));
    expect(cacheB.size()).toBe(0); // 已 detach → announce 不進快取
  });

  it('多跳：C 經 B 轉發看到 A 的房（原簽在第二跳仍可驗）', async () => {
    const a = await makeIdentity();
    const b = await makeIdentity();
    const [busAB_a, busAB_b] = busPair(); // A—B
    const [busBC_b, busBC_c] = busPair(); // B—C
    const cacheA = new RoomAdvertCache();
    const cacheB = new RoomAdvertCache();
    const cacheC = new RoomAdvertCache();
    const adA = await makeAdvert(a, 'room-a');
    const adB = await makeAdvert(b, 'room-b');

    // B 的 announce 集合 = 自己的房 + 快取轉發（多跳的關鍵，同 useCourierNode 的接法）
    const bAnnounce = async () => mergeAnnounceSet([adB], cacheB.list());
    attachRoomDirectory({ bus: busAB_b, cache: cacheB, localUid: 'b', announceIntervalMs: 0, getLocalAdverts: bAnnounce });
    attachRoomDirectory({ bus: busAB_a, cache: cacheA, localUid: 'a', announceIntervalMs: 0, getLocalAdverts: async () => [adA] });
    await new Promise((r) => setTimeout(r, 50));
    expect(cacheB.list().map((x) => x.roomId)).toEqual(['room-a']); // 第一跳

    // C 之後才連上 B：B attach 時 announce（此刻快取已含 room-a）→ C 收到 A 的房
    attachRoomDirectory({ bus: busBC_c, cache: cacheC, localUid: 'c', announceIntervalMs: 0, getLocalAdverts: async () => [] });
    attachRoomDirectory({ bus: busBC_b, cache: cacheB, localUid: 'b', announceIntervalMs: 0, getLocalAdverts: bAnnounce });
    await new Promise((r) => setTimeout(r, 50));
    expect(cacheC.list().map((x) => x.roomId).sort()).toEqual(['room-a', 'room-b']);
  });
});

describe('mergeAnnounceSet', () => {
  it('自己的優先、同房去重、cap 截斷', async () => {
    const a = await makeIdentity();
    const own = [await makeAdvert(a, 'r1', Date.now(), '我的')];
    const cached = [
      await makeAdvert(a, 'r1', Date.now() - 1000, '快取舊版'), // 同房 → 去重（自己的贏）
      await makeAdvert(a, 'r2'),
      await makeAdvert(a, 'r3'),
    ];
    const merged = mergeAnnounceSet(own, cached, 2);
    expect(merged.map((x) => x.roomId)).toEqual(['r1', 'r2']); // cap=2 截斷
    expect(merged[0].roomName).toBe('我的');
  });
});
