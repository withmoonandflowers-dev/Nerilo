import { describe, it, expect } from 'vitest';
import { NeriloTransportClient } from '../../src/sdk/transport';
import { RoomContentKeyRing } from '../../src/core/mesh/RoomContentKeys';
import type { MeshGossipManager } from '../../src/core/mesh/MeshGossipManager';

/**
 * Spec 023 T5：transport 契約測試（Node 層）。
 * 真 WebRTC 留給 E2E（T6）；這裡用對接的假 DataChannel＋真金鑰環（真 AES-GCM），
 * 驗證通道語義：密文上線、丟棄計數、輪替不停流、未連 peer 拋錯、關閉語義。
 */

class FakeDataChannel {
  readyState: RTCDataChannelState = 'open';
  binaryType = 'blob';
  label: string;
  onmessage: ((ev: { data: ArrayBuffer }) => void) | null = null;
  onclose: (() => void) | null = null;
  onopen: (() => void) | null = null;
  onerror: ((e: unknown) => void) | null = null;
  peer: FakeDataChannel | null = null;
  wire: ArrayBuffer[] = []; // 線上封包快照（V2：斷言密文）

  constructor(label: string) { this.label = label; }

  send(data: ArrayBuffer): void {
    if (this.readyState !== 'open') throw new Error('closed');
    this.wire.push(data);
    const p = this.peer;
    if (p && p.readyState === 'open') {
      queueMicrotask(() => p.onmessage?.({ data }));
    }
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

function pipe(a: string): [FakeDataChannel, FakeDataChannel] {
  const x = new FakeDataChannel(a);
  const y = new FakeDataChannel(a);
  x.peer = y; y.peer = x;
  return [x, y];
}

async function makeRing(epochs: number[]): Promise<RoomContentKeyRing> {
  const ring = new RoomContentKeyRing('room-t', 'user-t');
  for (const ep of epochs) {
    const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);
    ring.setContentKey(key, ep);
  }
  return ring;
}

/** 兩端（A 主動、B 被動）的 stub mesh：A openRawChannel → B 的 onRawDataChannel 收到對接端。 */
function makeManagers(ringA: RoomContentKeyRing, ringB: RoomContentKeyRing) {
  let bReceiver: ((label: string, dc: unknown) => void) | null = null;
  const mk = (ring: RoomContentKeyRing, self: string, other: string, isA: boolean) => ({
    initialize: async () => {},
    cleanup: async () => {},
    isInitialized: () => true,
    getUserId: () => self,
    getEncryptionState: () => (ring.hasSendKey() ? 'encrypted' : 'exchanging'),
    getConnectionState: () => ({ neighborCount: 1, totalNeighbors: 1, isConnected: true }),
    getConnectedNeighborIds: () => [other],
    getContentKeyRing: () => ring,
    getNeighborConnection: (peerId: string) => {
      if (peerId !== other) return undefined;
      return {
        getP2PManager: () => ({
          openRawDataChannel: (label: string, _init?: RTCDataChannelInit) => {
            const [x, y] = pipe(label);
            if (isA) bReceiver?.(label.replace(/^raw:/, ''), y);
            return x;
          },
          onRawDataChannel: (cb: (label: string, dc: unknown) => void) => {
            if (!isA) bReceiver = cb;
          },
        }),
      };
    },
  });
  return {
    a: mk(ringA, 'A', 'B', true) as unknown as MeshGossipManager,
    b: mk(ringB, 'B', 'A', false) as unknown as MeshGossipManager,
  };
}

async function flush(): Promise<void> {
  // 真非同步（SubtleCrypto）＋ queueMicrotask 遞送：等一小段真時間最可靠
  await new Promise((r) => setTimeout(r, 20));
}

describe('NeriloTransportClient（Spec 023 T5）', () => {
  it('端到端：A 開通道、B 被動收到，字串往返；線上一律密文（V2）', async () => {
    const ring = await makeRing([0]);
    const { a, b } = makeManagers(ring, ring);
    const A = new NeriloTransportClient(a);
    const B = new NeriloTransportClient(b);
    await A.connect(); await B.connect();

    const gotB: unknown[] = [];
    B.onRawChannel((ch) => ch.onMessage((d, from) => gotB.push([d, from])));

    const ch = await A.openRawChannel('B', 'inputs', { ordered: false, maxRetransmits: 0 });
    ch.send('{"t":"i","w":[[556,7]]}');
    await flush();

    expect(gotB).toEqual([['{"t":"i","w":[[556,7]]}', 'A']]);
    expect(ch.dropped()).toBe(0);
    await A.dispose(); await B.dispose();
  });

  it('V2 密文斷言：線上 frame 不含明文 bytes', async () => {
    const ring = await makeRing([0]);
    const [x, y] = pipe('raw:probe');
    void y;
    // 直接用 client 內部同一條密封路徑：sealRawFrame 經 send 上線
    const { sealRawFrame } = await import('../../src/core/p2p/RawChannelCrypto');
    const frame = await sealRawFrame(ring, 'SECRET-PLAINTEXT-MARKER');
    x.send(frame!.buffer as ArrayBuffer);
    const wireBytes = new Uint8Array(x.wire[0]!);
    const wireText = new TextDecoder('utf-8', { fatal: false }).decode(wireBytes);
    expect(wireText).not.toContain('SECRET-PLAINTEXT-MARKER');
  });

  it('金鑰未就緒：send 丟棄＋計數，B 零收（不排隊、不退明文）', async () => {
    const emptyRing = await makeRing([]); // A 無金鑰
    const ringB = await makeRing([0]);
    const { a, b } = makeManagers(emptyRing, ringB);
    const A = new NeriloTransportClient(a);
    const B = new NeriloTransportClient(b);
    await A.connect(); await B.connect();

    const gotB: unknown[] = [];
    B.onRawChannel((ch) => ch.onMessage((d) => gotB.push(d)));
    const ch = await A.openRawChannel('B', 'inputs');
    ch.send('must-not-leak');
    await flush();

    expect(ch.dropped()).toBe(1);
    expect(gotB).toHaveLength(0);
    await A.dispose(); await B.dispose();
  });

  it('輪替不停流：A 換新代（epoch 1），B 持雙代仍連續收到（V 系）', async () => {
    const ringA = await makeRing([0]);
    const ringB = new RoomContentKeyRing('room-t', 'B');
    // B 與 A 共用 epoch0 金鑰、稍後補 epoch1：模擬「保留前代」機制
    const k0 = ringA.getSendKeyWithEpoch()!.key;
    ringB.setContentKey(k0, 0);

    const { a, b } = makeManagers(ringA, ringB);
    const A = new NeriloTransportClient(a);
    const B = new NeriloTransportClient(b);
    await A.connect(); await B.connect();

    const gotB: unknown[] = [];
    B.onRawChannel((ch) => ch.onMessage((d) => gotB.push(d)));
    const ch = await A.openRawChannel('B', 'inputs');

    ch.send('epoch0-frame');
    await flush();
    const k1 = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);
    ringA.setContentKey(k1, 1); // A 輪替
    ringB.setContentKey(k1, 1); // B 收到新代（keyx 既有機制），前代保留
    ch.send('epoch1-frame');
    await flush();

    expect(gotB).toEqual(['epoch0-frame', 'epoch1-frame']);
    await A.dispose(); await B.dispose();
  });

  it('peer 未連上：openRawChannel 拋錯（不排隊）', async () => {
    const ring = await makeRing([0]);
    const { a } = makeManagers(ring, ring);
    const A = new NeriloTransportClient(a);
    await A.connect();
    await expect(A.openRawChannel('nobody', 'x')).rejects.toThrow(/peer not connected/);
    await A.dispose();
  });

  it('通道關閉：onClose 透出；之後 send 丟棄＋計數', async () => {
    const ring = await makeRing([0]);
    const { a, b } = makeManagers(ring, ring);
    const A = new NeriloTransportClient(a);
    const B = new NeriloTransportClient(b);
    await A.connect(); await B.connect();

    const ch = await A.openRawChannel('B', 'inputs');
    let closed = false;
    ch.onClose(() => { closed = true; });
    ch.close();
    expect(closed).toBe(true);
    ch.send('after-close');
    await flush();
    expect(ch.dropped()).toBe(1);
    await A.dispose(); await B.dispose();
  });
});
