/**
 * Transport 層壓力測試（0.11.0 發佈前驗證：Spec 023/025/026 在量與併發下的行為）。
 *
 * 走真 AES-GCM 密封管線（RawChannelCrypto），連線層用行程內對接的假 DataChannel
 * （N 節點全網 stub mesh）——測的是協議與收斂邏輯在量下的正確性，不含 WebRTC/ICE 開銷
 * （那部分由 examples 頁的真瀏覽器驗證覆蓋）。
 *
 * 場景：
 *  - ordered raw 通道 2000 則訊息嚴格保序（驗 Spec 026 修訂的入站序列化）
 *  - SharedState：8 節點 × 併發寫入風暴 → 全員收斂一致
 *  - SharedState：同 key 併發互蓋 → 全員最終一致；刪除風暴後不復活
 *  - SharedState：寫入中晚進者仍收斂
 *  - FileTransfer：邊界尺寸（0/1/16K/16K+1/整數倍）雜湊一致
 *  - FileTransfer：8MB 大檔＋5 筆併發傳輸＋取消風暴
 *
 * `npm run test:stress` 執行；不進預設 ci。
 * @vitest-environment node
 */
import { describe, it, expect } from 'vitest';
import { NeriloTransportClient } from '../../src/sdk/transport';
import { RoomContentKeyRing } from '../../src/core/mesh/RoomContentKeys';
import { sha256Hex } from '../../src/sdk/fileTransfer';
import type { MeshGossipManager } from '../../src/core/mesh/MeshGossipManager';

// ── N 節點全網 stub mesh ────────────────────────────────────────────────────

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

function meshNet(names: string[], ring: RoomContentKeyRing) {
  const receivers = new Map<string, ((label: string, dc: unknown) => void) | null>();
  const managers = new Map<string, MeshGossipManager>();
  for (const self of names) {
    const others = () => names.filter((n) => n !== self);
    managers.set(self, {
      initialize: async () => {},
      cleanup: async () => {},
      isInitialized: () => true,
      getUserId: () => self,
      getEncryptionState: () => 'encrypted',
      getConnectionState: () => ({ neighborCount: names.length - 1, totalNeighbors: names.length - 1, isConnected: true }),
      getConnectedNeighborIds: () => others(),
      getContentKeyRing: () => ring,
      getNeighborConnection: (peerId: string) => {
        if (!others().includes(peerId)) return undefined;
        return {
          getP2PManager: () => ({
            openRawDataChannel: (label: string) => {
              const x = new FakeDataChannel(label);
              const y = new FakeDataChannel(label);
              x.peer = y; y.peer = x;
              receivers.get(peerId)?.(label.replace(/^raw:/, ''), y);
              return x;
            },
            onRawDataChannel: (cb: (label: string, dc: unknown) => void) => { receivers.set(self, cb); },
          }),
        };
      },
    } as unknown as MeshGossipManager);
  }
  return managers;
}

async function makeRing(): Promise<RoomContentKeyRing> {
  const r = new RoomContentKeyRing('stress', 'u');
  r.setContentKey(await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']), 0);
  return r;
}

function randomBytes(n: number): Uint8Array {
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i += 65536) crypto.getRandomValues(out.subarray(i, Math.min(i + 65536, n)));
  return out;
}

const settle = (ms = 50) => new Promise((r) => setTimeout(r, ms));

/** 正規化視圖比較：toView 的 key 順序依各節點「到達順序」而異，必須排序後再比。 */
const canon = (v: Record<string, unknown>) =>
  JSON.stringify(Object.keys(v).sort().map((k) => [k, v[k]]));

/** 輪詢直到條件成立或逾時（壓力場景下固定 sleep 不可靠）。 */
async function until(cond: () => boolean, timeoutMs = 15_000): Promise<void> {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > timeoutMs) throw new Error('until: timeout');
    await settle(25);
  }
}

describe('raw 通道保序（Spec 026 修訂的迴歸鎖）', () => {
  it('ordered 通道 2000 則訊息嚴格依序到達（非同步解密不得重排）', async () => {
    const ring = await makeRing();
    const managers = meshNet(['A', 'B'], ring);
    const A = new NeriloTransportClient(managers.get('A')!);
    const B = new NeriloTransportClient(managers.get('B')!);
    await A.connect(); await B.connect();

    const got: number[] = [];
    const inbound = new Promise<void>((res) => {
      B.onRawChannel((ch) => {
        ch.onMessage((d) => {
          got.push(Number(d));
          if (got.length === 2000) res();
        });
      });
    });
    const ch = await A.openRawChannel('B', 'ordered-stress', { ordered: true });
    for (let i = 0; i < 2000; i++) ch.send(String(i));
    await inbound;

    expect(got.length).toBe(2000);
    for (let i = 0; i < 2000; i++) expect(got[i]).toBe(i);
    expect(ch.dropped()).toBe(0);
    await A.dispose(); await B.dispose();
  }, 30_000);
});

describe('SharedState 壓力（Spec 025）', () => {
  it('8 節點併發寫入風暴（480 筆增量）→ 全員收斂一致', async () => {
    const ring = await makeRing();
    const names = ['n1', 'n2', 'n3', 'n4', 'n5', 'n6', 'n7', 'n8'];
    const managers = meshNet(names, ring);
    const clients = new Map(names.map((n) => [n, new NeriloTransportClient(managers.get(n)!)]));
    for (const c of clients.values()) await c.connect();
    const states = new Map(names.map((n) => [n, clients.get(n)!.sharedState()]));
    await settle(100); // 通道網成形

    // 每節點 60 筆，寫到 20 個 key（同 key 跨節點互蓋）
    for (let i = 0; i < 60; i++) {
      for (const n of names) {
        states.get(n)!.set(`k${(i * 7 + n.charCodeAt(1)) % 20}`, { by: n, i });
      }
      if (i % 10 === 0) await settle(5); // 模擬節奏，不是必要條件
    }

    const viewOf = (n: string) => canon(states.get(n)!.get());
    await until(() => names.every((n) => viewOf(n) === viewOf('n1')));
    expect(Object.keys(states.get('n1')!.get()).length).toBe(20);
    for (const c of clients.values()) await c.dispose();
  }, 30_000);

  it('同 key 500 筆互蓋＋刪除風暴 → 一致且刪除不復活', async () => {
    const ring = await makeRing();
    const names = ['a', 'b', 'c', 'd'];
    const managers = meshNet(names, ring);
    const clients = new Map(names.map((n) => [n, new NeriloTransportClient(managers.get(n)!)]));
    for (const c of clients.values()) await c.connect();
    const states = new Map(names.map((n) => [n, clients.get(n)!.sharedState()]));
    await settle(80);

    for (let i = 0; i < 125; i++) for (const n of names) states.get(n)!.set('hot', `${n}-${i}`);
    await until(() => names.every((n) => canon(states.get(n)!.get()) === canon(states.get('a')!.get())));

    states.get('b')!.delete('hot'); // 最後動作是刪除
    await until(() => names.every((n) => !('hot' in states.get(n)!.get())));
    for (const c of clients.values()) await c.dispose();
  }, 30_000);

  it('寫入風暴進行中晚進者加入 → 仍收斂到與全員一致', async () => {
    const ring = await makeRing();
    const names = ['a', 'b', 'c', 'late'];
    const managers = meshNet(names, ring);
    const early = ['a', 'b', 'c'];
    const clients = new Map<string, NeriloTransportClient>();
    for (const n of early) {
      const c = new NeriloTransportClient(managers.get(n)!);
      await c.connect();
      clients.set(n, c);
    }
    const states = new Map(early.map((n) => [n, clients.get(n)!.sharedState()]));
    await settle(80);

    // 前半風暴
    for (let i = 0; i < 30; i++) for (const n of early) states.get(n)!.set(`k${i % 10}`, `${n}-${i}`);
    // 晚進者於風暴中途加入
    const late = new NeriloTransportClient(managers.get('late')!);
    await late.connect();
    clients.set('late', late);
    states.set('late', late.sharedState());
    // 後半風暴（晚進者也寫）
    for (let i = 30; i < 60; i++) for (const n of names) states.get(n)!.set(`k${i % 10}`, `${n}-${i}`);

    const viewOf = (n: string) => canon(states.get(n)!.get());
    await until(() => names.every((n) => viewOf(n) === viewOf('a')));
    expect(Object.keys(states.get('late')!.get()).length).toBe(10);
    for (const c of clients.values()) await c.dispose();
  }, 30_000);
});

describe('FileTransfer 壓力（Spec 026）', () => {
  async function pair() {
    const ring = await makeRing();
    const managers = meshNet(['A', 'B'], ring);
    const A = new NeriloTransportClient(managers.get('A')!);
    const B = new NeriloTransportClient(managers.get('B')!);
    await A.connect(); await B.connect();
    return { A, B };
  }

  it('邊界尺寸全過：0 / 1 / 16K / 16K+1 / 160K（整數倍）', async () => {
    const { A, B } = await pair();
    const received: Uint8Array[] = [];
    B.onFileOffer((offer) => { void offer.accept().done.then((r) => received.push(r.data)); });

    const sizes = [0, 1, 16 * 1024, 16 * 1024 + 1, 160 * 1024];
    for (const size of sizes) {
      const payload = randomBytes(size);
      const tx = A.sendFile('B', payload, { name: `s${size}` });
      await tx.done;
      const got = received[received.length - 1]!;
      expect(got.length).toBe(size);
      expect(await sha256Hex(got)).toBe(await sha256Hex(payload));
    }
    await A.dispose(); await B.dispose();
  }, 30_000);

  it('8MB 大檔（512 chunks，跨 16 個 ack 視窗）雜湊一致', async () => {
    const { A, B } = await pair();
    const payload = randomBytes(8 * 1024 * 1024);
    const done = new Promise<Uint8Array>((res, rej) => {
      B.onFileOffer((o) => o.accept().done.then((r) => res(r.data), rej));
    });
    const tx = A.sendFile('B', payload);
    await tx.done;
    expect(await sha256Hex(await done)).toBe(await sha256Hex(payload));
    await A.dispose(); await B.dispose();
  }, 30_000);

  it('5 筆併發傳輸（同一對 peer，各自專用通道）全數驗證通過', async () => {
    const { A, B } = await pair();
    const results: Promise<Uint8Array>[] = [];
    const pending: Array<(v: Uint8Array) => void> = [];
    B.onFileOffer((o) => { void o.accept().done.then((r) => pending.shift()?.(r.data)); });

    const payloads = Array.from({ length: 5 }, (_, i) => randomBytes(256 * 1024 + i));
    for (const p of payloads) {
      results.push(new Promise((res) => pending.push(res)));
      void p; // 先掛好接收
    }
    const txs = payloads.map((p, i) => A.sendFile('B', p, { name: `f${i}` }));
    await Promise.all(txs.map((t) => t.done));
    const got = await Promise.all(results);

    // 併發下完成順序不保證，比對集合（雜湊多重集一致）
    const wantHashes = (await Promise.all(payloads.map(sha256Hex))).sort();
    const gotHashes = (await Promise.all(got.map(sha256Hex))).sort();
    expect(gotHashes).toEqual(wantHashes);
    await A.dispose(); await B.dispose();
  }, 30_000);

  it('取消風暴：10 筆傳輸取消 5 筆，其餘 5 筆完好', async () => {
    const { A, B } = await pair();
    B.onFileOffer((o) => { void o.accept().done.catch(() => { /* 取消路徑 */ }); });

    const txs = Array.from({ length: 10 }, (_, i) => A.sendFile('B', randomBytes(512 * 1024), { name: `t${i}` }));
    for (let i = 0; i < 10; i += 2) txs[i]!.cancel(); // 取消偶數筆

    const outcomes = await Promise.allSettled(txs.map((t) => t.done));
    for (let i = 0; i < 10; i++) {
      if (i % 2 === 0) expect(outcomes[i]!.status).toBe('rejected');
      else expect(outcomes[i]!.status).toBe('fulfilled');
    }
    await A.dispose(); await B.dispose();
  }, 30_000);
});
