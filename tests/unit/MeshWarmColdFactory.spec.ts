/**
 * buildWarmColdFactory 現況釘子（characterization，Spec 015 T1 前置）。
 *
 * 這條路徑今天在 production 跑（mesh 每條鄰居連線的 signaling 都經過它），卻**零測試覆蓋**
 * ——`MeshGossipManager.spec.ts` 的 IdentityManager mock 沒有 `getEcdhPrivateKey`，
 * 所以既有測試只走到「無金鑰 → 退原 factory」那一支，warm 的組裝從未被驗證過。
 *
 * 015-T1 要把這段組裝重構成可從外部注入（`WarmSignalingDeps`）。依憲法第 6 條，
 * 先釘住今天的行為再改：以下每條斷言描述的都是**現行**行為，不是期望行為。
 * 重構後這支測試必須一字不改仍全綠；紅了代表弄壞了運作中的路徑（harden-tests 鐵律 3）。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── 捕捉建構參數的 mock ──────────────────────────────────────────────────────
const warmColdCalls: unknown[][] = [];
const peerRelayCalls: unknown[][] = [];
let hasOpenNeighborsReturn = false;

vi.mock('../../src/core/p2p/WarmColdSignalingTransport', () => ({
  WarmColdSignalingTransport: vi.fn().mockImplementation(function (...args: unknown[]) {
    warmColdCalls.push(args);
    return { __kind: 'warmcold', args };
  }),
}));

vi.mock('../../src/core/p2p/PeerRelaySignalingTransport', () => ({
  PeerRelaySignalingTransport: vi.fn().mockImplementation(function (...args: unknown[]) {
    peerRelayCalls.push(args);
    return { __kind: 'peerrelay', args };
  }),
}));

vi.mock('../../src/core/p2p/SigRelayRouter', () => ({
  SigRelayRouter: vi.fn().mockImplementation(function () {
    return { hasOpenNeighbors: () => hasOpenNeighborsReturn };
  }),
}));

vi.mock('../../src/core/p2p/DirectoryPeerKeyResolver', () => ({
  createDirectoryPeerKeyResolver: vi.fn().mockImplementation((fn: unknown) => ({ __resolver: fn })),
}));

vi.mock('../../src/config/firebase', () => ({ auth: { currentUser: null }, db: {} }));

import { MeshGossipManager } from '../../src/core/mesh/MeshGossipManager';

const LOCAL_UID = 'uid-local';

/** 造一個未 initialize 的 manager，並把身分金鑰換成可控的 stub。 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function makeManager(opts: { keys: boolean; introducerUid?: string; baseFactory?: any } = { keys: true }) {
  const m = new MeshGossipManager(
    'room-1',
    LOCAL_UID,
    opts.baseFactory,
    undefined,
    opts.introducerUid
  );
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (m as any).identityManager = {
    getEcdhPrivateKey: () => {
      if (!opts.keys) throw new Error('no ecdh key');
      return { __k: 'ecdh' } as unknown as CryptoKey;
    },
    getPrivateKey: () => {
      if (!opts.keys) throw new Error('no ecdsa key');
      return { __k: 'ecdsa' } as unknown as CryptoKey;
    },
  };
  return m;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const build = (m: MeshGossipManager) => (m as any).buildWarmColdFactory(LOCAL_UID);

describe('buildWarmColdFactory 現況釘子（Spec 015 T1 characterization）', () => {
  beforeEach(() => {
    warmColdCalls.length = 0;
    peerRelayCalls.length = 0;
    hasOpenNeighborsReturn = false;
    vi.clearAllMocks();
  });

  it('C1 取不到身分金鑰 → 原樣回傳注入的 factory，完全不建 WarmCold（無 warm 語義）', () => {
    const base = vi.fn();
    const factory = build(makeManager({ keys: false, baseFactory: base }));
    expect(factory).toBe(base); // 同一個參考，不是包過的
    expect(warmColdCalls).toHaveLength(0);
    expect(peerRelayCalls).toHaveLength(0);
  });

  it('C1b 取不到金鑰且未注入 factory → 回傳 undefined（維持既有行為，呼叫端自理預設）', () => {
    expect(build(makeManager({ keys: false }))).toBeUndefined();
  });

  it('C2 有金鑰但呼叫端未帶 remoteUid → 純 cold：warm=null 且 hasWarmPath 恆 false', () => {
    const factory = build(makeManager({ keys: true }));
    factory('room-1', 'ch-a'); // 不帶第三參數
    expect(peerRelayCalls).toHaveLength(0); // 封不了加密信封，不建 warm
    expect(warmColdCalls).toHaveLength(1);
    const [warm, _cold, hasWarmPath, label] = warmColdCalls[0];
    expect(warm).toBeNull();
    expect((hasWarmPath as () => boolean)()).toBe(false);
    expect(label).toBe('ch-a');
  });

  it('C3 有金鑰且帶 remoteUid → 建 warm，且 hasWarmPath 實時委派 router.hasOpenNeighbors', () => {
    const factory = build(makeManager({ keys: true }));
    factory('room-1', 'ch-b', 'uid-remote');
    expect(peerRelayCalls).toHaveLength(1);
    expect(warmColdCalls).toHaveLength(1);
    const [warm, _cold, hasWarmPath] = warmColdCalls[0];
    expect(warm).not.toBeNull();

    // 實時委派，不是建構當下的快照
    hasOpenNeighborsReturn = false;
    expect((hasWarmPath as () => boolean)()).toBe(false);
    hasOpenNeighborsReturn = true;
    expect((hasWarmPath as () => boolean)()).toBe(true);
  });

  it('C3b warm 拿到的參數：router、身分、roomId、channelLabel、remoteUid 依序到位', () => {
    const factory = build(makeManager({ keys: true }));
    factory('room-1', 'ch-c', 'uid-remote');
    const args = peerRelayCalls[0];
    expect(args[3]).toBe('room-1'); // roomId
    expect(args[4]).toBe('ch-c'); // channelLabel
    expect(args[6]).toBe('uid-remote'); // remoteUid
    const identity = args[1] as { nodeId: string; epoch: number };
    expect(identity.nodeId).toBe(LOCAL_UID);
    expect(identity.epoch).toBe(0);
  });

  it('C4 cold 工廠延遲求值：建構當下不呼叫注入的 base factory', () => {
    const base = vi.fn().mockReturnValue({ __kind: 'cold' });
    const factory = build(makeManager({ keys: true, baseFactory: base }));
    factory('room-1', 'ch-d', 'uid-remote');
    expect(base).not.toHaveBeenCalled(); // 還沒有人要 cold

    const cold = warmColdCalls[0][1] as () => unknown;
    cold();
    expect(base).toHaveBeenCalledWith('room-1', 'ch-d', 'uid-remote');
  });

  it('C5 我是被邀請者：對介紹人本人不等 warm（bootstrap 第一跳直接 cold）', async () => {
    const factory = build(makeManager({ keys: true, introducerUid: 'uid-intro' }));
    factory('room-1', 'ch-e', 'uid-intro');
    const patience = warmColdCalls[0][4] as { applies: () => Promise<boolean> };
    expect(await patience.applies()).toBe(false);
  });

  it('C5b 我是被邀請者：對介紹人以外的 pair 要等 warm', async () => {
    const factory = build(makeManager({ keys: true, introducerUid: 'uid-intro' }));
    factory('room-1', 'ch-f', 'uid-other');
    const patience = warmColdCalls[0][4] as { applies: () => Promise<boolean> };
    expect(await patience.applies()).toBe(true);
  });

  it('C6 我不是被邀請者：對端由「別人」介紹 → 等 warm；由我介紹 → 立即 cold', async () => {
    const m = makeManager({ keys: true });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (m as any).latestDirectorySnapshot = {
      meshIdentities: {
        'uid-byother': { userId: 'u1', pubKey: 'p1', introducedBy: 'uid-someone-else' },
        'uid-byme': { userId: 'u2', pubKey: 'p2', introducedBy: LOCAL_UID },
        'uid-plain': { userId: 'u3', pubKey: 'p3' },
      },
      participants: [],
    };
    const factory = build(m);

    factory('room-1', 'ch-g', 'uid-byother');
    const pByOther = warmColdCalls[0][4] as { applies: () => Promise<boolean> };
    expect(await pByOther.applies()).toBe(true);

    factory('room-1', 'ch-h', 'uid-byme');
    const pByMe = warmColdCalls[1][4] as { applies: () => Promise<boolean> };
    expect(await pByMe.applies()).toBe(false); // 我即會合點

    factory('room-1', 'ch-i', 'uid-plain');
    const pPlain = warmColdCalls[2][4] as { applies: () => Promise<boolean> };
    expect(await pPlain.applies()).toBe(false); // 無 introducedBy 欄位
  });

  it('C7 耐心參數的現行數值（改動即為協議級決策，不可無聲調整）', () => {
    const factory = build(makeManager({ keys: true }));
    factory('room-1', 'ch-j', 'uid-remote');
    const patience = warmColdCalls[0][4] as { totalMs: number; retryDelayMs: number };
    expect(patience.totalMs).toBe(12_000);
    expect(patience.retryDelayMs).toBe(1_000);
  });
});
