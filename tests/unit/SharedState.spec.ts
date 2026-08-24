import { describe, it, expect } from 'vitest';
import { NeriloTransportClient } from '../../src/sdk/transport';
import { RoomContentKeyRing } from '../../src/core/mesh/RoomContentKeys';
import type { MeshGossipManager } from '../../src/core/mesh/MeshGossipManager';

/**
 * Spec 025 T4：共享狀態契約測試。
 * 雙向 stub mesh（兩端都可開/收 raw 通道）＋真金鑰環（真 AES-GCM），走完整 raw 密封管線。
 */

class FakeDataChannel {
  readyState: RTCDataChannelState = 'open';
  binaryType = 'blob';
  onmessage: ((ev: { data: ArrayBuffer }) => void) | null = null;
  onclose: (() => void) | null = null;
  onopen: (() => void) | null = null;
  onerror: ((e: unknown) => void) | null = null;
  peer: FakeDataChannel | null = null;
  constructor(public label: string) {}
  send(data: ArrayBuffer): void {
    const p = this.peer;
    if (p && p.readyState === 'open') queueMicrotask(() => p.onmessage?.({ data }));
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
function meshPair(ringA: RoomContentKeyRing, ringB: RoomContentKeyRing) {
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
            const x = new FakeDataChannel(label);
            const y = new FakeDataChannel(label);
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
  };
}

async function sharedRing(): Promise<RoomContentKeyRing> {
  const ring = new RoomContentKeyRing('room-ss', 'u');
  ring.setContentKey(await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']), 0);
  return ring;
}

const flush = () => new Promise((r) => setTimeout(r, 30));

describe('SharedState（Spec 025）', () => {
  it('A set → B 看得到（含 onChange 事件與變更 keys）', async () => {
    const ring = await sharedRing();
    const { a, b } = meshPair(ring, ring);
    const A = new NeriloTransportClient(a);
    const B = new NeriloTransportClient(b);
    await A.connect(); await B.connect();
    const sA = A.sharedState();
    const sB = B.sharedState();
    await flush(); // 通道建立 + 互催快照

    const events: Array<[Record<string, unknown>, string[]]> = [];
    sB.onChange((st, keys) => events.push([st, keys]));
    sA.set('score', { p1: 3, p2: 1 });
    await flush();

    expect(sB.get()).toEqual({ score: { p1: 3, p2: 1 } });
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
    await flush();

    expect(sB.get()).toEqual({ map: 'desert', round: 2 }); // 現況，無 temp
    await A.dispose(); await B.dispose();
  });

  it('並發寫同 key：兩端最終視圖一致（LWW）', async () => {
    const ring = await sharedRing();
    const { a, b } = meshPair(ring, ring);
    const A = new NeriloTransportClient(a);
    const B = new NeriloTransportClient(b);
    await A.connect(); await B.connect();
    const sA = A.sharedState();
    const sB = B.sharedState();
    await flush();

    sA.set('turn', 'A-says');
    sB.set('turn', 'B-says'); // 幾乎同時
    await flush();

    expect(sA.get()['turn']).toBe(sB.get()['turn']); // 收斂一致（誰勝由 HLC 裁決）
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
    const { a, b } = meshPair(ring, ring);
    const A = new NeriloTransportClient(a);
    const B = new NeriloTransportClient(b);
    await A.connect(); await B.connect();
    const leaked: string[] = [];
    B.onRawChannel((ch) => leaked.push(ch.label));
    A.sharedState(); B.sharedState();
    await flush();
    expect(leaked).toEqual([]); // state 通道分流走了
    await A.dispose(); await B.dispose();
  });
});
