import { describe, it, expect } from 'vitest';
import { NeriloTransportClient } from '../../src/sdk/transport';
import { RoomContentKeyRing } from '../../src/core/mesh/RoomContentKeys';
import { encodeChunk, decodeChunk, sha256Hex } from '../../src/sdk/fileTransfer';
import type { MeshGossipManager } from '../../src/core/mesh/MeshGossipManager';

/** Spec 026 T4：檔案傳輸契約測試（雙向 stub mesh＋真 AES-GCM 密封管線）。 */

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

function meshPair(ring: RoomContentKeyRing) {
  const receivers: Record<string, ((label: string, dc: unknown) => void) | null> = { A: null, B: null };
  const mk = (self: 'A' | 'B', other: 'A' | 'B') => ({
    initialize: async () => {},
    cleanup: async () => {},
    isInitialized: () => true,
    getUserId: () => self,
    getEncryptionState: () => 'encrypted',
    getConnectionState: () => ({ neighborCount: 1, totalNeighbors: 1, isConnected: true }),
    getConnectedNeighborIds: () => [other],
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
  return { a: mk('A', 'B') as unknown as MeshGossipManager, b: mk('B', 'A') as unknown as MeshGossipManager };
}

async function ring(): Promise<RoomContentKeyRing> {
  const r = new RoomContentKeyRing('room-f', 'u');
  r.setContentKey(await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']), 0);
  return r;
}

function randomBytes(n: number): Uint8Array {
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i += 65536) crypto.getRandomValues(out.subarray(i, Math.min(i + 65536, n)));
  return out;
}

describe('檔案傳輸（Spec 026）', () => {
  it('chunk 編解碼往返（純函式）', () => {
    const bytes = randomBytes(1000);
    const d = decodeChunk(encodeChunk(7, 42, bytes));
    expect(d.id).toBe(7);
    expect(d.seq).toBe(42);
    expect([...d.bytes]).toEqual([...bytes]);
    expect(() => decodeChunk(new Uint8Array(3))).toThrow(/too short/);
  });

  it('1MB 隨機資料往返：雜湊一致、進度單調、metadata 保留', async () => {
    const r = await ring();
    const { a, b } = meshPair(r);
    const A = new NeriloTransportClient(a);
    const B = new NeriloTransportClient(b);
    await A.connect(); await B.connect();

    const payload = randomBytes(1024 * 1024);
    const gotProgress: number[] = [];
    const received = new Promise<{ data: Uint8Array; name?: string }>((res, rej) => {
      B.onFileOffer((offer) => {
        expect(offer.size).toBe(payload.length);
        expect(offer.name).toBe('replay.bin');
        const rx = offer.accept();
        rx.onProgress((got) => gotProgress.push(got));
        rx.done.then(res, rej);
      });
    });

    const tx = A.sendFile('B', payload, { name: 'replay.bin', mime: 'application/octet-stream' });
    await tx.done;
    const result = await received;

    expect(await sha256Hex(result.data)).toBe(await sha256Hex(payload));
    expect(result.name).toBe('replay.bin');
    for (let i = 1; i < gotProgress.length; i++) expect(gotProgress[i]!).toBeGreaterThan(gotProgress[i - 1]!);
    expect(gotProgress[gotProgress.length - 1]).toBe(payload.length);
    await A.dispose(); await B.dispose();
  }, 30000);

  it('未註冊 handler：自動拒收，送方 done reject', async () => {
    const r = await ring();
    const { a, b } = meshPair(r);
    const A = new NeriloTransportClient(a);
    const B = new NeriloTransportClient(b);
    await A.connect(); await B.connect();
    const tx = A.sendFile('B', randomBytes(1000));
    await expect(tx.done).rejects.toThrow(/no-handler/);
    await A.dispose(); await B.dispose();
  });

  it('明示拒絕：送方收到 reason', async () => {
    const r = await ring();
    const { a, b } = meshPair(r);
    const A = new NeriloTransportClient(a);
    const B = new NeriloTransportClient(b);
    await A.connect(); await B.connect();
    B.onFileOffer((offer) => offer.reject('not-now'));
    const tx = A.sendFile('B', randomBytes(1000));
    await expect(tx.done).rejects.toThrow(/not-now/);
    await A.dispose(); await B.dispose();
  });

  it('送方取消：兩側 done reject（fail-visible）', async () => {
    const r = await ring();
    const { a, b } = meshPair(r);
    const A = new NeriloTransportClient(a);
    const B = new NeriloTransportClient(b);
    await A.connect(); await B.connect();
    let rxDone: Promise<unknown> | null = null;
    B.onFileOffer((offer) => { rxDone = offer.accept().done; });
    const tx = A.sendFile('B', randomBytes(1024 * 1024));
    tx.cancel();
    await expect(tx.done).rejects.toThrow(/cancelled/);
    await new Promise((res) => setTimeout(res, 30));
    if (rxDone) await expect(rxDone).rejects.toThrow(/cancelled|closed/);
    await A.dispose(); await B.dispose();
  });

  it('超上限：sendFile 直接拋錯（不進協議）', async () => {
    const r = await ring();
    const { a } = meshPair(r);
    const A = new NeriloTransportClient(a);
    await A.connect();
    const fake = { length: 65 * 1024 * 1024 } as unknown as Uint8Array;
    expect(() => A.sendFile('B', fake)).toThrow(/too large/);
    await A.dispose();
  });
});
