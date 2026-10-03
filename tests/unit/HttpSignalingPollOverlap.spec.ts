import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createHttpSignaling, createHttpRoomDirectory } from '../../src/sdk/httpSignaling';
import type { RawSignalDoc } from '../../src/core/p2p/SignalingTransport.types';
import type { RoomSnapshot } from '../../src/ports/IRoomDirectory';

/**
 * 輪詢重疊回歸（T-009）：fetch 耗時大於 pollMs 時，setInterval 不得在上一輪未回來前再發一輪。
 * 假 fetch 的延遲由假時鐘控制，不靠真 server 與機器負載重現。
 */

const POLL_MS = 50;
const SLOW_MS = 120; // 大於 POLL_MS：舊實作在這段時間內會多發兩輪

interface FakeCall { url: string; startedAt: number }

/** 可控延遲的假 fetch：`respond` 依第幾次呼叫決定延遲與回應內容；同時記錄最大並行數。 */
function installFakeFetch(respond: (call: FakeCall, index: number) => { delayMs: number; body?: unknown; fail?: boolean }) {
  const calls: FakeCall[] = [];
  let inFlight = 0;
  let maxInFlight = 0;
  vi.stubGlobal('fetch', (url: string) => {
    const call = { url: String(url), startedAt: Date.now() };
    const index = calls.push(call) - 1;
    const { delayMs, body, fail } = respond(call, index);
    inFlight++;
    maxInFlight = Math.max(maxInFlight, inFlight);
    return new Promise((resolve, reject) => {
      setTimeout(() => {
        inFlight--;
        if (fail) reject(new Error('network down'));
        else resolve({ ok: true, status: 200, json: async () => body });
      }, delayMs);
    });
  });
  return { calls, maxInFlight: () => maxInFlight };
}

const signal = (seq: number, from: string) => ({
  seq,
  createdAtMs: 1000 + seq,
  doc: { from, to: null, type: 'offer', payload: {}, channelLabel: 'ch', signalId: `sig-${seq}` } as unknown as RawSignalDoc,
});

const afterOf = (url: string) => Number(new URL(url).searchParams.get('after'));

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('createHttpSignaling 輪詢不重疊', () => {
  it('fetch 耗時大於 pollMs：同一筆訊號只投遞一次，且同時最多一輪在途', async () => {
    const stored = [signal(1, 'alice')];
    const fake = installFakeFetch((call) => ({
      delayMs: SLOW_MS,
      body: { signals: stored.filter((s) => s.seq > afterOf(call.url)) },
    }));
    const got: RawSignalDoc[] = [];
    const off = createHttpSignaling('http://rv.test', { pollMs: POLL_MS })('room', 'ch').subscribe(0, (d) => got.push(d));

    await vi.advanceTimersByTimeAsync(600);
    off();

    expect(got.map((d) => d.from)).toEqual(['alice']);
    expect(fake.maxInFlight()).toBe(1);
  });

  it('上一輪回來後照常續輪：後到的訊號仍會收到，游標有前進', async () => {
    const stored = [signal(1, 'alice')];
    const fake = installFakeFetch((call) => ({
      delayMs: SLOW_MS,
      body: { signals: stored.filter((s) => s.seq > afterOf(call.url)) },
    }));
    const got: RawSignalDoc[] = [];
    const off = createHttpSignaling('http://rv.test', { pollMs: POLL_MS })('room', 'ch').subscribe(0, (d) => got.push(d));

    await vi.advanceTimersByTimeAsync(300);
    stored.push(signal(2, 'bob'));
    await vi.advanceTimersByTimeAsync(600);
    off();

    expect(got.map((d) => d.from)).toEqual(['alice', 'bob']);
    expect(afterOf(fake.calls[fake.calls.length - 1]!.url)).toBe(2);
  });

  it('某一輪 fetch 失敗後，在途旗標要放掉，下一輪照常收', async () => {
    const stored = [signal(1, 'alice')];
    installFakeFetch((call, index) => index === 0
      ? { delayMs: SLOW_MS, fail: true }
      : { delayMs: 10, body: { signals: stored.filter((s) => s.seq > afterOf(call.url)) } });
    const got: RawSignalDoc[] = [];
    const off = createHttpSignaling('http://rv.test', { pollMs: POLL_MS })('room', 'ch').subscribe(0, (d) => got.push(d));

    await vi.advanceTimersByTimeAsync(400);
    off();

    expect(got.map((d) => d.from)).toEqual(['alice']);
  });

  it('取消訂閱後，進行中的那一輪回來不得再投遞，也不再發新一輪', async () => {
    const fake = installFakeFetch(() => ({ delayMs: SLOW_MS, body: { signals: [signal(1, 'alice')] } }));
    const got: RawSignalDoc[] = [];
    const off = createHttpSignaling('http://rv.test', { pollMs: POLL_MS })('room', 'ch').subscribe(0, (d) => got.push(d));

    await vi.advanceTimersByTimeAsync(30); // 第一輪在途
    off();
    const callsAtOff = fake.calls.length;
    await vi.advanceTimersByTimeAsync(600);

    expect(got).toEqual([]);
    expect(fake.calls.length).toBe(callsAtOff);
  });
});

describe('createHttpRoomDirectory.watchIdentities 輪詢不重疊', () => {
  const snapshot = (version: number, participants: string[]) => ({ meshIdentities: {}, participants, version });

  it('慢的舊回應不得蓋掉快的新回應：名冊不倒退，且同時最多一輪在途', async () => {
    // 第 1 輪慢（拿到 v1），之後的輪次快（拿到 v2）。舊實作會依序通知 v2 → v1 → v2。
    const fake = installFakeFetch((_call, index) => index === 0
      ? { delayMs: SLOW_MS, body: snapshot(1, ['a']) }
      : { delayMs: 10, body: snapshot(2, ['a', 'b']) });
    const seen: RoomSnapshot[] = [];
    const off = createHttpRoomDirectory('http://rv.test', 'room', 'a', { pollMs: POLL_MS }).watchIdentities((s) => seen.push(s));

    await vi.advanceTimersByTimeAsync(600);
    off();

    expect(seen.map((s) => s.participants.length)).toEqual([1, 2]);
    expect(fake.maxInFlight()).toBe(1);
  });

  it('某一輪 fetch 失敗後，下一輪照常通知', async () => {
    installFakeFetch((_call, index) => index === 0
      ? { delayMs: SLOW_MS, fail: true }
      : { delayMs: 10, body: snapshot(1, ['a']) });
    const seen: RoomSnapshot[] = [];
    const off = createHttpRoomDirectory('http://rv.test', 'room', 'a', { pollMs: POLL_MS }).watchIdentities((s) => seen.push(s));

    await vi.advanceTimersByTimeAsync(400);
    off();

    expect(seen.map((s) => s.participants)).toEqual([['a']]);
  });

  it('取消訂閱後，進行中的那一輪回來不得再通知', async () => {
    installFakeFetch(() => ({ delayMs: SLOW_MS, body: snapshot(1, ['a']) }));
    const seen: RoomSnapshot[] = [];
    const off = createHttpRoomDirectory('http://rv.test', 'room', 'a', { pollMs: POLL_MS }).watchIdentities((s) => seen.push(s));

    await vi.advanceTimersByTimeAsync(30);
    off();
    await vi.advanceTimersByTimeAsync(600);

    expect(seen).toEqual([]);
  });
});
