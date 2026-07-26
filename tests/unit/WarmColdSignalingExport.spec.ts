/**
 * createWarmColdSignaling 公開出口測試（Spec 015 T3，含驗收 V2）。
 *
 * 本 spec 最可能的失敗模式不是「跑不動」，是**文件說得比程式好聽**：
 * 嵌入者以為裝上 warm 就有零伺服器中繼，實際上沒有 mesh 就沒有中繼底材。
 * V2 因此把「無 warm 後端 ⇒ 行為等同純 cold」釘成可執行斷言，而不是 README 的但書。
 * @vitest-environment node
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { SignalingTransport } from '../../src/core/p2p/SignalingTransport.types';

const peerRelayCalls: unknown[][] = [];
vi.mock('../../src/core/p2p/PeerRelaySignalingTransport', () => ({
  PeerRelaySignalingTransport: vi.fn().mockImplementation(function (...args: unknown[]) {
    peerRelayCalls.push(args);
    return { __kind: 'warm' };
  }),
}));

vi.mock('../../src/config/firebase', () => ({ auth: { currentUser: null }, db: {} }));

import { createWarmColdSignaling, createFirestoreSignaling } from '../../src/sdk/firestore';
import type { WarmSignalingBackend } from '../../src/sdk/firestore';

const fakeTransport = (): SignalingTransport => ({
  subscribe: () => () => {},
  send: async () => {},
  cleanupOlderThan: async () => {},
  cleanupOwn: async () => {},
});

function makeWarmBackend(over: Partial<WarmSignalingBackend> = {}): WarmSignalingBackend {
  return {
    nodeId: 'uid-local',
    relayBus: { relay: () => {}, onInbound: () => () => {} },
    hasWarmPath: () => true,
    identity: {
      ecdhPrivateKey: {} as CryptoKey,
      sign: async () => 'sig',
    },
    peerKeys: {
      ecdhPublicOf: async () => ({}) as CryptoKey,
      verifierOf: async () => async () => true,
    },
    ...over,
  };
}

describe('createWarmColdSignaling（Spec 015 T3）', () => {
  beforeEach(() => {
    peerRelayCalls.length = 0;
    vi.clearAllMocks();
  });

  // ── V2：誠實性 ────────────────────────────────────────────────────────────
  it('V2 省略 warm → 直接回傳 cold 工廠本身（不加殼，等價是可驗證的事實）', () => {
    const cold = vi.fn().mockReturnValue(fakeTransport());
    expect(createWarmColdSignaling({ cold })).toBe(cold);
  });

  it('V2 省略 warm 時完全不建 warm 傳輸（不會有「看起來像 warm」的空殼）', () => {
    const cold = vi.fn().mockReturnValue(fakeTransport());
    createWarmColdSignaling({ cold })('room', 'ch', 'uid-remote');
    expect(peerRelayCalls).toHaveLength(0);
  });

  it('V2 省略 warm 與 cold → 與 createFirestoreSignaling 同形狀（同步回傳 transport、不碰 Firestore）', () => {
    const viaWarmCold = createWarmColdSignaling()('room', 'ch');
    const viaFirestore = createFirestoreSignaling()('room', 'ch');
    for (const t of [viaWarmCold, viaFirestore]) {
      expect(typeof t.subscribe).toBe('function');
      expect(typeof t.send).toBe('function');
      expect(typeof t.cleanupOlderThan).toBe('function');
      expect(typeof t.cleanupOwn).toBe('function');
    }
  });

  // ── warm 真的接上時 ───────────────────────────────────────────────────────
  it('提供 warm 且帶 remoteUid → 建 warm 傳輸，身分與對端依序到位', () => {
    createWarmColdSignaling({
      cold: () => fakeTransport(),
      warm: makeWarmBackend(),
    })('room-1', 'ch-a', 'uid-remote');

    expect(peerRelayCalls).toHaveLength(1);
    const args = peerRelayCalls[0];
    expect(args[3]).toBe('room-1');
    expect(args[4]).toBe('ch-a');
    expect(args[6]).toBe('uid-remote');
    expect((args[1] as { nodeId: string }).nodeId).toBe('uid-local');
  });

  it('提供 warm 但呼叫端未帶 remoteUid → 封不了信封，仍走純 cold', () => {
    createWarmColdSignaling({
      cold: () => fakeTransport(),
      warm: makeWarmBackend(),
    })('room-1', 'ch-b');
    expect(peerRelayCalls).toHaveLength(0);
  });

  it('identity.epoch 省略時預設為 0（金鑰世代，供收端選鑰）', () => {
    createWarmColdSignaling({
      cold: () => fakeTransport(),
      warm: makeWarmBackend(),
    })('room-1', 'ch-c', 'uid-remote');
    expect((peerRelayCalls[0][1] as { epoch: number }).epoch).toBe(0);
  });

  it('identity.epoch 有給時照用（輪替後的世代要傳得下去）', () => {
    createWarmColdSignaling({
      cold: () => fakeTransport(),
      warm: makeWarmBackend({
        identity: { ecdhPrivateKey: {} as CryptoKey, epoch: 7, sign: async () => 'sig' },
      }),
    })('room-1', 'ch-d', 'uid-remote');
    expect((peerRelayCalls[0][1] as { epoch: number }).epoch).toBe(7);
  });

  it('hasWarmPath 恆 false（沒有 mesh 鄰居）時仍可建工廠，不拋錯', () => {
    const factory = createWarmColdSignaling({
      cold: () => fakeTransport(),
      warm: makeWarmBackend({ hasWarmPath: () => false }),
    });
    expect(() => factory('room-1', 'ch-e', 'uid-remote')).not.toThrow();
  });
});
