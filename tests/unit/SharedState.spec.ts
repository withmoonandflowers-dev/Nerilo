import { describe, it, expect, vi } from 'vitest';
import { NeriloTransportClient } from '../../src/sdk/transport';
import { RoomContentKeyRing } from '../../src/core/mesh/RoomContentKeys';
import type { MeshGossipManager } from '../../src/core/mesh/MeshGossipManager';

/**
 * Spec 025 T4：共享狀態契約測試。
 * 雙向 stub mesh（兩端都可開/收 raw 通道）＋真金鑰環（真 AES-GCM），走完整 raw 密封管線。
 */

/**
 * 等條件成立，不用固定等待（T-012，2026-10-03）。
 * 原本每一步都 setTimeout 30ms 後直接斷言；訊息要過兩次非同步 AES-GCM（密封、開封），
 * 安靜時約 2ms，機器滿載時超過 30ms 就會斷言到空狀態。上限 4 秒只用來判定失敗，條件成立就立刻往下走。
 */
const until = (assertion: () => void) => vi.waitFor(assertion, { timeout: 4000, interval: 5 });

/** 測試鏈路：可注入送達延遲，並記下各端已送達對端的 frame 數（給「等條件」用，不靠固定等待）。 */
interface Link {
  latencyMs: number;
  delivered: Record<'A' | 'B', number>;
}

class FakeDataChannel {
  readyState: RTCDataChannelState = 'open';
  binaryType = 'blob';
  onmessage: ((ev: { data: ArrayBuffer }) => void) | null = null;
  onclose: (() => void) | null = null;
  onopen: (() => void) | null = null;
  onerror: ((e: unknown) => void) | null = null;
  peer: FakeDataChannel | null = null;
  constructor(public label: string, private link: Link, private owner: 'A' | 'B') {}
  send(data: ArrayBuffer): void {
    const p = this.peer;
    if (!p || p.readyState !== 'open') return;
    const deliver = () => {
      if (!p.onmessage) return;
      this.link.delivered[this.owner]++;
      p.onmessage({ data });
    };
    if (this.link.latencyMs > 0) setTimeout(deliver, this.link.latencyMs);
    else queueMicrotask(deliver);
  }
  close(): void {
    this.readyState = 'closed';
    this.onclose?.();
    if (this.peer && this.peer.readyState === 'open') {
      this.peer.readyState = 'closed';
      this.peer.onclose?.();
    }
  }
}

/** 全雙向 stub：任一端 openRawDataChannel，對端的 receiver 都會收到對接通道。 */
function meshPair(ringA: RoomContentKeyRing, ringB: RoomContentKeyRing, latencyMs = 0) {
  const link: Link = { latencyMs, delivered: { A: 0, B: 0 } };
  const receivers: Record<string, ((label: string, dc: unknown) => void) | null> = { A: null, B: null };
  const connectedAt: Record<string, boolean> = { A: true, B: true };
  const mk = (self: 'A' | 'B', other: 'A' | 'B', ring: RoomContentKeyRing) => ({
    initialize: async () => {},
    cleanup: async () => {},
    isInitialized: () => true,
    getUserId: () => self,
    getEncryptionState: () => 'encrypted',
    getConnectionState: () => ({ neighborCount: 1, totalNeighbors: 1, isConnected: true }),
    getConnectedNeighborIds: () => (connectedAt[self] ? [other] : []),
    getContentKeyRing: () => ring,
    getNeighborConnection: (peerId: string) => {
      if (peerId !== other) return undefined;
      return {
        getP2PManager: () => ({
          openRawDataChannel: (label: string) => {
            const x = new FakeDataChannel(label, link, self);
            const y = new FakeDataChannel(label, link, other);
            x.peer = y; y.peer = x;
            receivers[other]?.(label.replace(/^raw:/, ''), y);
            return x;
          },
          onRawDataChannel: (cb: (label: string, dc: unknown) => void) => { receivers[self] = cb; },
        }),
      };
    },
  });
  return {
    a: mk('A', 'B', ringA) as unknown as MeshGossipManager,
    b: mk('B', 'A', ringB) as unknown as MeshGossipManager,
    setConnected(self: 'A' | 'B', v: boolean) { connectedAt[self] = v; },
    /** 兩端的 state 通道都已把第一則訊息送到對端（outbound 已建立、密封管線已通）。 */
    channelsReady: () => until(() => expect(link.delivered.A > 0 && link.delivered.B > 0).toBe(true)),
  };
}

async function sharedRing(): Promise<RoomContentKeyRing> {
  const ring = new RoomContentKeyRing('room-ss', 'u');
  ring.setContentKey(await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']), 0);
  return ring;
}

describe('SharedState（Spec 025）', () => {
  it('A set → B 看得到（含 onChange 事件與變更 keys）', async () => {
    const ring = await sharedRing();
    const { a, b, channelsReady } = meshPair(ring, ring);
    const A = new NeriloTransportClient(a);
    const B = new NeriloTransportClient(b);
    await A.connect(); await B.connect();
    const sA = A.sharedState();
    const sB = B.sharedState();
    await channelsReady(); // 通道建立

    const events: Array<[Record<string, unknown>, string[]]> = [];
    sB.onChange((st, keys) => events.push([st, keys]));
    sA.set('score', { p1: 3, p2: 1 });

    await until(() => expect(sB.get()).toEqual({ score: { p1: 3, p2: 1 } }));
    expect(events[events.length - 1]![1]).toEqual(['score']);
    await A.dispose(); await B.dispose();
  });

  it('晚進者補齊：A 先寫，B 後連上，get 拿到現況；刪除的鍵不復活', async () => {
    const ring = await sharedRing();
    const { a, b } = meshPair(ring, ring);
    const A = new NeriloTransportClient(a);
    await A.connect();
    const sA = A.sharedState();
    sA.set('map', 'desert');
    sA.set('round', 2);
    sA.set('temp', 'x');
    sA.delete('temp');

    const B = new NeriloTransportClient(b); // 晚進
    await B.connect();
    const sB = B.sharedState();

    await until(() => expect(sB.get()).toEqual({ map: 'desert', round: 2 })); // 現況，無 temp
    await A.dispose(); await B.dispose();
  });

  it('並發寫同 key：兩端最終視圖一致（LWW）', async () => {
    const ring = await sharedRing();
    const { a, b, channelsReady } = meshPair(ring, ring);
    const A = new NeriloTransportClient(a);
    const B = new NeriloTransportClient(b);
    await A.connect(); await B.connect();
    const sA = A.sharedState();
    const sB = B.sharedState();
    await channelsReady();

    sA.set('turn', 'A-says');
    sB.set('turn', 'B-says'); // 幾乎同時

    await until(() => expect(sA.get()['turn']).toBe(sB.get()['turn'])); // 收斂一致（誰勝由 HLC 裁決）
    await A.dispose(); await B.dispose();
  });

  it('大小上限 fail-visible：單值超 8KB 拋錯，狀態不變', async () => {
    const ring = await sharedRing();
    const { a } = meshPair(ring, ring);
    const A = new NeriloTransportClient(a);
    await A.connect();
    const sA = A.sharedState();
    expect(() => sA.set('big', 'x'.repeat(9000))).toThrow(/too large/);
    expect(sA.get()).toEqual({});
    await A.dispose();
  });

  it("保留 label：'state' 通道不會漏給嵌入者的 onRawChannel", async () => {
    const ring = await sharedRing();
    const { a, b, channelsReady } = meshPair(ring, ring);
    const A = new NeriloTransportClient(a);
    const B = new NeriloTransportClient(b);
    await A.connect(); await B.connect();
    const leaked: string[] = [];
    B.onRawChannel((ch) => leaked.push(ch.label));
    A.sharedState(); B.sharedState();
    await channelsReady(); // state 通道確實開了、訊息也到了，才檢查有沒有漏
    expect(leaked).toEqual([]); // state 通道分流走了
    await A.dispose(); await B.dispose();
  });

  it('鏈路送達延遲 50ms：A set 後 B 仍會看到（T-012 迴歸：固定等 30ms 的寫法在這裡必紅）', async () => {
    const ring = await sharedRing();
    const { a, b, channelsReady } = meshPair(ring, ring, 50);
    const A = new NeriloTransportClient(a);
    const B = new NeriloTransportClient(b);
    await A.connect(); await B.connect();
    const sA = A.sharedState();
    const sB = B.sharedState();
    await channelsReady();

    const events: Array<[Record<string, unknown>, string[]]> = [];
    sB.onChange((st, keys) => events.push([st, keys]));
    sA.set('score', { p1: 3, p2: 1 });
    expect(sB.get()).toEqual({}); // 還在路上：這一刻斷言最終值就是原本的偶發紅

    await until(() => expect(sB.get()).toEqual({ score: { p1: 3, p2: 1 } }));
    expect(events[events.length - 1]![1]).toEqual(['score']);
    await A.dispose(); await B.dispose();
  });
});
