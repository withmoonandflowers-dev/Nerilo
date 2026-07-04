/**
 * IceServerProvider — 社群 TURN 來源測試（ADR-0012 P1）
 *
 * - 清單 fetch + 驗證合併（壞條目逐筆丟棄）
 * - 清單不可用（404/網路錯）→ 靜默略過，STUN 照常
 * - 快取：TTL 內不重複 fetch
 * - 健康探測：不健康的伺服器被「後續」呼叫過濾（首連不阻塞）
 *
 * @vitest-environment node
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { IceServerProvider, resetIceServerProvider } from '../../src/core/p2p/IceServerProvider';

const LIST_URL = '/community-turn.json';

function okJson(body: unknown): Response {
  return { ok: true, json: async () => body } as unknown as Response;
}

function makeFetch(body: unknown) {
  return vi.fn(async () => okJson(body)) as unknown as typeof fetch;
}

/** 假 RTCPeerConnection：可控制探測結果（emit relay candidate 或永不） */
function makePcFactory(behavior: 'relay' | 'silent') {
  const created: Array<Record<string, unknown>> = [];
  const factory = ((config: RTCConfiguration) => {
    const pc: Record<string, unknown> = {
      config,
      onicecandidate: null as null | ((ev: { candidate: { candidate: string } | null }) => void),
      createDataChannel: vi.fn(),
      close: vi.fn(),
      createOffer: vi.fn(async () => ({ type: 'offer', sdp: 'x' })),
      setLocalDescription: vi.fn(async function (this: void) {
        if (behavior === 'relay') {
          // 模擬非同步產出 relay candidate
          queueMicrotask(() => {
            const cb = pc.onicecandidate as ((ev: { candidate: { candidate: string } }) => void) | null;
            cb?.({ candidate: { candidate: 'candidate:1 1 udp 123 1.2.3.4 3478 typ relay' } });
          });
        }
      }),
    };
    created.push(pc);
    return pc as unknown as RTCPeerConnection;
  }) as (config: RTCConfiguration) => RTCPeerConnection;
  return { factory, created };
}

const VALID_ENTRY = {
  urls: ['turn:turn.volunteer.org:3478'],
  username: 'nerilo',
  credential: 'secret',
};

describe('IceServerProvider — 社群 TURN', () => {
  beforeEach(() => {
    resetIceServerProvider();
    vi.restoreAllMocks();
  });

  it('合併社群 TURN 到 ICE servers（STUN 之後）', async () => {
    const provider = new IceServerProvider({
      communityTurnUrl: LIST_URL,
      fetchFn: makeFetch({ version: 1, servers: [VALID_ENTRY] }),
      pcFactory: makePcFactory('relay').factory,
    });
    const servers = await provider.getIceServers();
    const turn = servers.find((s) => JSON.stringify(s.urls).includes('turn.volunteer.org'));
    expect(turn).toBeDefined();
    expect((turn as RTCIceServer & { username: string }).username).toBe('nerilo');
  });

  it('壞條目逐筆丟棄，好條目保留', async () => {
    const provider = new IceServerProvider({
      communityTurnUrl: LIST_URL,
      fetchFn: makeFetch({
        servers: [
          VALID_ENTRY,
          { urls: ['http://evil.example/x'], username: 'a', credential: 'b' }, // 非 turn:
          { urls: ['turn:no-cred.org:3478'] }, // 缺帳密
          'garbage',
        ],
      }),
      pcFactory: makePcFactory('relay').factory,
    });
    const servers = await provider.getIceServers();
    const turns = servers.filter((s) => JSON.stringify(s.urls ?? '').includes('turn'));
    expect(turns).toHaveLength(1);
  });

  it('清單 404 → 靜默略過，STUN 照常回傳', async () => {
    const provider = new IceServerProvider({
      communityTurnUrl: LIST_URL,
      fetchFn: vi.fn(async () => ({ ok: false, status: 404 })) as unknown as typeof fetch,
    });
    const servers = await provider.getIceServers();
    expect(servers.length).toBeGreaterThanOrEqual(2); // 預設 STUN
    expect(servers.every((s) => String(s.urls).startsWith('stun:'))).toBe(true);
  });

  it('TTL 內快取：第二次呼叫不重複 fetch', async () => {
    const fetchFn = makeFetch({ servers: [VALID_ENTRY] });
    const provider = new IceServerProvider({
      communityTurnUrl: LIST_URL,
      fetchFn,
      pcFactory: makePcFactory('relay').factory,
    });
    await provider.getIceServers();
    await provider.getIceServers();
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it('健康探測失敗 → 後續呼叫過濾該伺服器（首連不阻塞）', async () => {
    vi.useFakeTimers();
    const { factory } = makePcFactory('silent'); // 永不產出 relay candidate
    const provider = new IceServerProvider({
      communityTurnUrl: LIST_URL,
      fetchFn: makeFetch({ servers: [VALID_ENTRY] }),
      pcFactory: factory,
    });

    // 首次：未知健康 → 放行 + 觸發背景探測
    const first = await provider.getIceServers();
    expect(first.some((s) => JSON.stringify(s.urls).includes('turn.volunteer.org'))).toBe(true);

    // 探測 5 秒逾時 → 標記不健康
    await vi.advanceTimersByTimeAsync(5_100);

    const second = await provider.getIceServers();
    expect(second.some((s) => JSON.stringify(s.urls).includes('turn.volunteer.org'))).toBe(false);
    vi.useRealTimers();
  });

  it('健康探測成功 → 後續呼叫保留', async () => {
    const { factory } = makePcFactory('relay');
    const provider = new IceServerProvider({
      communityTurnUrl: LIST_URL,
      fetchFn: makeFetch({ servers: [VALID_ENTRY] }),
      pcFactory: factory,
    });
    await provider.getIceServers();
    await new Promise((r) => setTimeout(r, 0)); // 讓 microtask 的 relay candidate 送達
    const second = await provider.getIceServers();
    expect(second.some((s) => JSON.stringify(s.urls).includes('turn.volunteer.org'))).toBe(true);
  });

  it('未設定 communityTurnUrl → 完全不 fetch', async () => {
    const fetchFn = makeFetch({ servers: [VALID_ENTRY] });
    const provider = new IceServerProvider({ fetchFn });
    await provider.getIceServers();
    expect(fetchFn).not.toHaveBeenCalled();
  });
});
