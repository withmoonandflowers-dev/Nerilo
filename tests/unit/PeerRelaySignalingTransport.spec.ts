/**
 * PeerRelaySignalingTransport 測試（Spec 005 T2）—— 暖 mesh 中繼 signaling。
 *
 * 記憶體多節點證明「自主連線 + 介紹人不可信」：
 *  - A↔B、B↔C 暖連（C 與 A 素未謀面，唯一暖路徑是經 B）。
 *  - C 經 B 中繼把 offer 送到 A，A 驗簽＋解密還原 SDP（往返成立、零伺服器）。
 *  - 介紹人 B 只依 `to` 轉密文：斷言 B 讀不到 SDP（B 的 ECDH 私鑰導不出同一把共享密鑰、
 *    B 轉發的位元組不含明文），且 B 竄改 → A 驗簽失敗、不建立錯誤連線。
 *
 * 用真實 WebCrypto ECDH(P-256)+ECDSA，跑的是真傳輸類別（非 mock）。
 *
 * @vitest-environment node
 */
import { describe, it, expect, beforeAll } from 'vitest';
import {
  PeerRelaySignalingTransport,
  type SignalRelayBus,
  type LocalSignalIdentity,
  type PeerKeyResolver,
} from '../../src/core/p2p/PeerRelaySignalingTransport';
import type { SignalEnvelope } from '../../src/core/p2p/SignalEnvelope';
import { openSignal } from '../../src/core/p2p/SignalEnvelope';
import type { RawSignalDoc } from '../../src/core/p2p/SignalingTransport.types';
import { webCryptoSigner } from '../../src/core/incentive/CreditLedger';

// ── 測試用節點身分 ────────────────────────────────────────────────────────────
interface Node {
  id: string;
  ecdh: CryptoKeyPair;
  identity: CryptoKeyPair;
  sig: ReturnType<typeof webCryptoSigner>;
}

function ecdh(): Promise<CryptoKeyPair> {
  return crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits', 'deriveKey']);
}
function ecdsa(): Promise<CryptoKeyPair> {
  return crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
}
async function makeNode(id: string): Promise<Node> {
  const identity = await ecdsa();
  return { id, ecdh: await ecdh(), identity, sig: webCryptoSigner(identity) };
}

// ── 記憶體 mesh 中繼：模擬暖連線圖，依 `to` 逐跳遞送，攔截中繼所見 ──────────────
/**
 * 節點只知道自己的暖鄰居（links）。relay(env) 從來源沿最短暖路徑遞送到 env.to；
 * 路徑上的中間節點＝介紹人，逐一觸發 relayTaps（供測試檢查介紹人所見）。
 */
type InboundHandler = (env: SignalEnvelope) => void | Promise<void>;

class InMemoryMeshRelay {
  private links = new Map<string, Set<string>>();
  private inbound = new Map<string, Set<InboundHandler>>();
  private pending: Array<Promise<void>> = [];
  /** 每當某節點以「中間人」身分轉發一則信封即呼叫（byNode＝介紹人，env＝它所見/所轉）。 */
  readonly relayTaps: Array<(byNode: string, env: SignalEnvelope) => void> = [];

  connect(a: string, b: string): void {
    (this.links.get(a) ?? this.links.set(a, new Set()).get(a)!).add(b);
    (this.links.get(b) ?? this.links.set(b, new Set()).get(b)!).add(a);
  }

  busFor(nodeId: string): SignalRelayBus {
    return {
      relay: (env) => this.route(nodeId, env),
      onInbound: (handler) => {
        const set = this.inbound.get(nodeId) ?? this.inbound.set(nodeId, new Set()).get(nodeId)!;
        set.add(handler);
        return () => { set.delete(handler); };
      },
    };
  }

  /** 等所有入站 handler 的 async 處理跑完（WebCrypto 走 threadpool，不能靠單一 tick）。 */
  async flush(): Promise<void> {
    while (this.pending.length) {
      const batch = this.pending;
      this.pending = [];
      await Promise.all(batch);
    }
  }

  private route(origin: string, env: SignalEnvelope): void {
    const path = this.shortestPath(origin, env.to);
    if (!path) return; // 無暖路徑：靜默丟（冷啟動走 Firestore，非本傳輸職責）
    // path = [origin, ...中間介紹人..., dest]；中間節點逐一以「介紹人」身分轉發。
    for (let i = 1; i < path.length - 1; i++) {
      for (const tap of this.relayTaps) tap(path[i]!, env);
    }
    this.inbound.get(env.to)?.forEach((h) => {
      const r = h(env);
      if (r) this.pending.push(r);
    });
  }

  private shortestPath(from: string, to: string): string[] | null {
    if (from === to) return [from];
    const prev = new Map<string, string>();
    const seen = new Set([from]);
    const q = [from];
    while (q.length) {
      const cur = q.shift()!;
      for (const nb of this.links.get(cur) ?? []) {
        if (seen.has(nb)) continue;
        seen.add(nb);
        prev.set(nb, cur);
        if (nb === to) {
          const path = [to];
          let c = to;
          while (c !== from) { c = prev.get(c)!; path.unshift(c); }
          return path;
        }
        q.push(nb);
      }
    }
    return null;
  }
}

// nodes：A、B（介紹人）、C。C 與 A 無直接暖連，只能經 B。
let A: Node, B: Node, C: Node;
let resolver: PeerKeyResolver;
let mesh: InMemoryMeshRelay;
let seq = 0;
const clock = { now: () => 1_700_000_000_000, nonce: () => `n-${++seq}` };

function identityFor(node: Node): LocalSignalIdentity {
  return { nodeId: node.id, ecdhPrivateKey: node.ecdh.privateKey, epoch: 0, sign: node.sig.sign };
}

beforeAll(async () => {
  [A, B, C] = await Promise.all([makeNode('A'), makeNode('B'), makeNode('C')]);
  const byId: Record<string, Node> = { A, B, C };
  resolver = {
    async ecdhPublicOf(id) { return byId[id]!.ecdh.publicKey; },
    async verifierOf(id) { return byId[id]!.sig.verify; },
  };
});

function freshMesh(): void {
  mesh = new InMemoryMeshRelay();
  mesh.connect('A', 'B'); // A↔B 暖
  mesh.connect('B', 'C'); // B↔C 暖（C↔A 無直連 → 唯一路徑 C-B-A）
}

const OFFER = { type: 'offer', sdp: 'v=0\r\no=- 42 IN IP4 192.168.7.7\r\na=candidate:host 192.168.7.7' };

describe('PeerRelaySignalingTransport — C 經 B 中繼連到 A（自主、零伺服器）', () => {
  it('C 送 offer→A，A 驗簽解密還原 SDP（往返成立）', async () => {
    freshMesh();
    const cSend = new PeerRelaySignalingTransport(mesh.busFor('C'), identityFor(C), resolver, 'room1', 'mesh-A-C', clock);
    const aRecv = new PeerRelaySignalingTransport(mesh.busFor('A'), identityFor(A), resolver, 'room1', 'mesh-A-C', clock, 'C');

    const got: RawSignalDoc[] = [];
    aRecv.subscribe(0, (raw) => got.push(raw));
    await cSend.send({ from: 'C', to: 'A', type: 'offer', payload: OFFER, channelLabel: 'mesh-A-C' });
    await mesh.flush(); // 等 receive 的 async 鏈（WebCrypto）跑完

    expect(got).toHaveLength(1);
    expect(got[0]!.from).toBe('C');
    expect(got[0]!.type).toBe('offer');
    expect(got[0]!.payload).toEqual(OFFER);
    expect(got[0]!.channelLabel).toBe('mesh-A-C');
    expect(got[0]!.signalId).toBeTruthy();
  });
});

describe('PeerRelaySignalingTransport — 介紹人 B 讀不到 SDP', () => {
  it('B 確實在中繼路徑上，但轉的是密文（不含明文 SDP／IP）', async () => {
    freshMesh();
    const relayed: Array<{ by: string; env: SignalEnvelope }> = [];
    mesh.relayTaps.push((by, env) => relayed.push({ by, env }));

    const cSend = new PeerRelaySignalingTransport(mesh.busFor('C'), identityFor(C), resolver, 'room1', 'mesh-A-C', clock);
    await cSend.send({ from: 'C', to: 'A', type: 'offer', payload: OFFER, channelLabel: 'mesh-A-C' });

    // B 是唯一中間人
    expect(relayed.map((r) => r.by)).toEqual(['B']);
    const seen = JSON.stringify(relayed[0]!.env);
    expect(seen).not.toContain('192.168.7.7'); // ICE 候選 IP 不外洩
    expect(seen).not.toContain('v=0');          // SDP 明文不外洩
  });

  it('B 拿自己的 ECDH 私鑰解不開（導不出 A 的共享密鑰）', async () => {
    freshMesh();
    const relayed: SignalEnvelope[] = [];
    mesh.relayTaps.push((_by, env) => relayed.push(env));
    const cSend = new PeerRelaySignalingTransport(mesh.busFor('C'), identityFor(C), resolver, 'room1', 'mesh-A-C', clock);
    await cSend.send({ from: 'C', to: 'A', type: 'offer', payload: OFFER, channelLabel: 'mesh-A-C' });

    // B 冒充收端，用自己的 ECDH 私鑰 + C 的公鑰 → AES-GCM 標籤失敗
    await expect(
      openSignal(relayed[0]!, 'A', B.ecdh.privateKey, C.ecdh.publicKey, C.sig.verify),
    ).rejects.toThrow();
  });

  it('B 竄改密文 → A 驗簽失敗，不建立錯誤連線（onAdded 不觸發）', async () => {
    freshMesh();
    // 惡意 B：攔截並改掉 ct 後才轉給 A。
    const evilMesh = new InMemoryMeshRelay();
    evilMesh.connect('B', 'C');
    const aInbound: InboundHandler[] = [];
    const aPending: Array<Promise<void>> = [];
    const aBus: SignalRelayBus = {
      relay: () => {},
      onInbound: (h) => { aInbound.push(h); return () => {}; },
    };
    // C 送到 B（B 是 to），B 竄改後改投 A。
    const cToB = new PeerRelaySignalingTransport(evilMesh.busFor('C'), identityFor(C), resolver, 'room1', 'mesh-A-C', clock);
    let captured: SignalEnvelope | null = null;
    evilMesh.busFor('B').onInbound((env) => { captured = env; });
    await cToB.send({ from: 'C', to: 'B', type: 'offer', payload: OFFER, channelLabel: 'mesh-A-C' });
    await evilMesh.flush();
    expect(captured).not.toBeNull();

    // B 把 from 改成 C、to 改成 A、竄改 ct（保留 C 的簽章）投給 A。
    const forged: SignalEnvelope = {
      ...(captured as unknown as SignalEnvelope),
      to: 'A',
      ct: Buffer.from('tampered-ciphertext-bytes').toString('base64'),
    };
    const aRecv = new PeerRelaySignalingTransport(aBus, identityFor(A), resolver, 'room1', 'mesh-A-C', clock, 'C');
    const got: RawSignalDoc[] = [];
    aRecv.subscribe(0, (raw) => got.push(raw));
    aInbound.forEach((h) => { const r = h(forged); if (r) aPending.push(r); });
    await Promise.all(aPending);

    expect(got).toHaveLength(0); // 驗簽失敗 → 丟棄，A 不建立連線
  });
});

describe('PeerRelaySignalingTransport — 定址與契約', () => {
  it('remoteNodeId 限定：別對的來源信封不餵給本連線', async () => {
    freshMesh();
    // A 這條實例綁 remote=C，但收到一則 from=B 的（合法）信封 → 應忽略。
    const aRecvForC = new PeerRelaySignalingTransport(mesh.busFor('A'), identityFor(A), resolver, 'room1', 'mesh-A-C', clock, 'C');
    const got: RawSignalDoc[] = [];
    aRecvForC.subscribe(0, (raw) => got.push(raw));

    const bSend = new PeerRelaySignalingTransport(mesh.busFor('B'), identityFor(B), resolver, 'room1', 'mesh-A-B', clock);
    await bSend.send({ from: 'B', to: 'A', type: 'offer', payload: OFFER, channelLabel: 'mesh-A-B' });
    await mesh.flush();

    expect(got).toHaveLength(0); // from=B 不等於綁定的 remote=C → 忽略
  });

  it('send 無 to 且無綁定對端 → 拋錯；無 to 但有綁定對端 → 退用綁定對端', async () => {
    freshMesh();
    const t = new PeerRelaySignalingTransport(mesh.busFor('C'), identityFor(C), resolver, 'room1', 'c', clock);
    await expect(
      t.send({ from: 'C', to: null, type: 'offer', payload: OFFER }),
    ).rejects.toThrow(/需要明確 to/);

    // manager 發起方首發 offer 時 to=null（尚未學到對端）：綁定 remoteNodeId 的
    // pair transport 必須退用它（否則 warm 首發全滅，T6 run10 實測抓到）。
    const bound = new PeerRelaySignalingTransport(mesh.busFor('C'), identityFor(C), resolver, 'room1', 'mesh-A-C', clock, 'A');
    const got: RawSignalDoc[] = [];
    new PeerRelaySignalingTransport(mesh.busFor('A'), identityFor(A), resolver, 'room1', 'mesh-A-C', clock, 'C')
      .subscribe(0, (raw) => got.push(raw));
    await bound.send({ from: 'C', to: null, type: 'offer', payload: OFFER });
    await mesh.flush();
    expect(got).toHaveLength(1); // 經綁定對端 A 收到
  });

  it('relay 被拒（NACK/無路）→ send 必須 reject（退 Firestore 的觸發訊號，不得漂走）', async () => {
    // T6 run15 破案的迴歸釘：bus.relay 回 rejected promise，send 若不 await 會假成功
    // → 上層永不退 cold → signaling 憑空消失。
    const rejectingBus: SignalRelayBus = {
      relay: () => Promise.reject(new Error('SigRelayRouter: 無暖路徑可達 A')),
      onInbound: () => () => {},
    };
    const t = new PeerRelaySignalingTransport(rejectingBus, identityFor(C), resolver, 'room1', 'mesh-A-C', clock, 'A');
    await expect(
      t.send({ from: 'C', to: 'A', type: 'offer', payload: OFFER }),
    ).rejects.toThrow(/無暖路徑/);
  });
});
