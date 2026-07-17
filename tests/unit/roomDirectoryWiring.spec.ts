/**
 * roomDirectoryWiring 測試（Spec 005 T5）—— 房間目錄 gossip 騎上暖 mesh 連線。
 *
 * 真協議（RoomDirectoryGossip 驗簽/快取）+ 假連線對：兩節點 attach 即互見對方房間
 * 廣告（零伺服器）；transitively，新 peer 連上介紹人一條線就拿到全目錄快取。
 *
 * @vitest-environment node
 */
import { describe, it, expect } from 'vitest';
import { wireRoomDirectoryOnConnection, type RoomDirCapableConnection } from '../../src/core/mesh/roomDirectoryWiring';
import { RoomAdvertCache, buildRoomAdvert, type RoomAdvert } from '../../src/core/relay/RoomDirectoryGossip';
import { ecdsaSigner } from '../../src/core/relay/CourierReceipts';
import { senderIdFromPubKey } from '../../src/core/relay/TombstoneCrypto';
import type { GossipRelayEnvelope } from '../../src/core/mesh/MeshConnection';
import { arrayBufferToBase64 } from '../../src/utils/crypto';

async function makeIdentity() {
  const kp = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const pubKey = arrayBufferToBase64(await crypto.subtle.exportKey('spki', kp.publicKey));
  return { pubKey, nodeId: await senderIdFromPubKey(pubKey), sign: ecdsaSigner(kp.privateKey) };
}

async function advertFor(id: Awaited<ReturnType<typeof makeIdentity>>, roomId: string): Promise<RoomAdvert> {
  return buildRoomAdvert(
    { roomId, roomName: '', ownerUid: '', participantCount: 2, issuedAt: Date.now(), nodeId: id.nodeId, pubKey: id.pubKey },
    id.sign
  );
}

/** 假連線對：一對 RoomDirCapableConnection，各自 send 觸發對方 listener。 */
function connPair(): [RoomDirCapableConnection, RoomDirCapableConnection] {
  const mk = () => {
    const listeners = new Set<(env: GossipRelayEnvelope) => void>();
    return {
      listeners,
      conn: {
        onRoomDir: (l: (env: GossipRelayEnvelope) => void) => { listeners.add(l); return () => listeners.delete(l); },
        send: null as unknown as (env: GossipRelayEnvelope) => Promise<void>,
        sendRoomDir(env: GossipRelayEnvelope) { return this.send(env); },
      },
    };
  };
  const a = mk();
  const b = mk();
  a.conn.send = async (env) => { await Promise.resolve(); b.listeners.forEach((l) => l(env)); };
  b.conn.send = async (env) => { await Promise.resolve(); a.listeners.forEach((l) => l(env)); };
  return [a.conn, b.conn];
}

const settle = () => new Promise((r) => setTimeout(r, 10));

/** 條件輪詢（上限 2s）：事件驅動收斂在全套負載下無固定時窗，盲等會 flake。 */
async function waitFor(cond: () => boolean, timeoutMs = 2_000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) return; // 逾時讓後續 expect 給出清楚斷言訊息
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe('roomDirectoryWiring — 目錄騎上暖 mesh', () => {
  it('兩端 attach 即互見對方房間廣告（驗簽入快取，零伺服器）', async () => {
    const [ca, cb] = connPair();
    const idA = await makeIdentity();
    const idB = await makeIdentity();
    const cacheA = new RoomAdvertCache();
    const cacheB = new RoomAdvertCache();

    const detachA = wireRoomDirectoryOnConnection(ca, {
      cache: cacheA, localUid: 'A',
      getLocalAdverts: async () => [await advertFor(idA, 'room-of-A')],
      announceIntervalMs: 0,
    });
    const detachB = wireRoomDirectoryOnConnection(cb, {
      cache: cacheB, localUid: 'B',
      getLocalAdverts: async () => [await advertFor(idB, 'room-of-B')],
      announceIntervalMs: 0,
    });
    await waitFor(() => cacheA.size() > 0 && cacheB.size() > 0);

    expect(cacheA.list().map((a) => a.roomId)).toContain('room-of-B');
    expect(cacheB.list().map((a) => a.roomId)).toContain('room-of-A');
    detachA(); detachB();
  });

  it('轉發鏈：C 只連 B，也拿得到 A 的房間廣告（B 快取轉播）', async () => {
    const idA = await makeIdentity();
    const idB = await makeIdentity();
    // B 的快取已有 A 的廣告（上一題的交換結果）
    const cacheB = new RoomAdvertCache();
    cacheB.upsert(await advertFor(idA, 'room-of-A'));

    const [cb2, cc] = connPair(); // B↔C 新連線
    const cacheC = new RoomAdvertCache();
    const detachB = wireRoomDirectoryOnConnection(cb2, {
      cache: cacheB, localUid: 'B',
      // mergeAnnounceSet 語義：自己的 + 快取裡別人的（原簽轉發）——這裡直接供給兩者
      getLocalAdverts: async () => [await advertFor(idB, 'room-of-B'), ...cacheB.list()],
      announceIntervalMs: 0,
    });
    const detachC = wireRoomDirectoryOnConnection(cc, {
      cache: cacheC, localUid: 'C',
      getLocalAdverts: async () => [],
      announceIntervalMs: 0,
    });
    await waitFor(() => cacheC.size() >= 2);

    const rooms = cacheC.list().map((a) => a.roomId);
    expect(rooms).toContain('room-of-B');
    expect(rooms).toContain('room-of-A'); // 沒連過 A、沒碰伺服器，經 B 一條線拿到
    detachB(); detachC();
  });

  it('壞簽章廣告不入快取（協議驗簽在 attach 層生效）', async () => {
    const [ca, cb] = connPair();
    const idA = await makeIdentity();
    const forged = { ...(await advertFor(idA, 'evil-room')), sig: 'Zm9yZ2Vk' };
    const cacheB = new RoomAdvertCache();
    const detachA = wireRoomDirectoryOnConnection(ca, {
      cache: new RoomAdvertCache(), localUid: 'A',
      getLocalAdverts: async () => [forged],
      announceIntervalMs: 0,
    });
    const detachB = wireRoomDirectoryOnConnection(cb, {
      cache: cacheB, localUid: 'B',
      getLocalAdverts: async () => [],
      announceIntervalMs: 0,
    });
    await settle();
    expect(cacheB.list()).toEqual([]);
    detachA(); detachB();
  });

  it('detach 後不再收（timer/訂閱都清）', async () => {
    const [ca, cb] = connPair();
    const idA = await makeIdentity();
    const cacheB = new RoomAdvertCache();
    const detachA = wireRoomDirectoryOnConnection(ca, {
      cache: new RoomAdvertCache(), localUid: 'A',
      getLocalAdverts: async () => [await advertFor(idA, 'room-late')],
      announceIntervalMs: 0,
    });
    const detachB = wireRoomDirectoryOnConnection(cb, {
      cache: cacheB, localUid: 'B', getLocalAdverts: async () => [], announceIntervalMs: 0,
    });
    detachB(); // B 立刻卸載
    await settle();
    expect(cacheB.list()).toEqual([]);
    detachA();
  });
});
