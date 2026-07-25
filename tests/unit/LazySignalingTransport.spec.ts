/**
 * createLazySignalingTransport 測試（Spec 015 T2）。
 *
 * 重點在「取消一個尚未成立的訂閱」——那是這層最容易寫錯、也最貴的地方：
 * 漏掉會留下拆不掉的 Firestore onSnapshot（持續計費 + 房間關了還投遞）。
 * @vitest-environment node
 */
import { describe, it, expect, vi } from 'vitest';
import { createLazySignalingTransport } from '../../src/core/p2p/lazySignalingTransport';
import type { RawSignalDoc, SignalingTransport } from '../../src/core/p2p/SignalingTransport.types';

/** 可控的假 transport：記錄呼叫，並讓測試手動推訊號。 */
function makeInner() {
  const unsub = vi.fn();
  const subscribers: ((raw: RawSignalDoc) => void)[] = [];
  const inner: SignalingTransport = {
    subscribe: vi.fn((_cutoff: number, onAdded: (raw: RawSignalDoc) => void) => {
      subscribers.push(onAdded);
      return unsub;
    }),
    send: vi.fn().mockResolvedValue(undefined),
    cleanupOlderThan: vi.fn().mockResolvedValue(undefined),
    cleanupOwn: vi.fn().mockResolvedValue(undefined),
  };
  return { inner, unsub, push: (d: RawSignalDoc) => subscribers.forEach((cb) => cb(d)) };
}

describe('createLazySignalingTransport', () => {
  it('建構當下不載入（延遲）：沒人用就不會去 import', () => {
    const load = vi.fn();
    createLazySignalingTransport(load);
    expect(load).not.toHaveBeenCalled();
  });

  it('載入只發生一次，多次操作共用同一個實例', async () => {
    const { inner } = makeInner();
    const load = vi.fn().mockResolvedValue(inner);
    const t = createLazySignalingTransport(load);
    await t.send({ a: 1 });
    await t.send({ b: 2 });
    await t.cleanupOwn('uid');
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('subscribe 同步回傳取消函式，載入完成後訊號才真的流過來', async () => {
    const { inner, push } = makeInner();
    let resolveLoad!: (t: SignalingTransport) => void;
    const t = createLazySignalingTransport(() => new Promise((r) => (resolveLoad = r)));

    const got: RawSignalDoc[] = [];
    const off = t.subscribe(0, (d) => got.push(d));
    expect(typeof off).toBe('function'); // 契約：同步拿到取消函式

    resolveLoad(inner);
    await vi.waitFor(() => expect(inner.subscribe).toHaveBeenCalled());
    push({ signalId: 's1', type: 'offer' });
    expect(got.map((d) => d.signalId)).toEqual(['s1']);
  });

  it('載入完成前就取消 → 完全不對內層訂閱（不留拆不掉的監聽）', async () => {
    const { inner } = makeInner();
    let resolveLoad!: (t: SignalingTransport) => void;
    const t = createLazySignalingTransport(() => new Promise((r) => (resolveLoad = r)));

    const off = t.subscribe(0, () => {});
    off(); // 載完之前就取消
    resolveLoad(inner);
    await Promise.resolve();
    await Promise.resolve();
    expect(inner.subscribe).not.toHaveBeenCalled();
  });

  it('載入完成後取消 → 轉呼叫內層的取消函式', async () => {
    const { inner, unsub } = makeInner();
    const t = createLazySignalingTransport(() => Promise.resolve(inner));
    const off = t.subscribe(0, () => {});
    await vi.waitFor(() => expect(inner.subscribe).toHaveBeenCalled());
    off();
    expect(unsub).toHaveBeenCalledTimes(1);
  });

  it('send / cleanup 皆轉呼叫內層並帶原參數', async () => {
    const { inner } = makeInner();
    const t = createLazySignalingTransport(() => Promise.resolve(inner));
    await t.send({ from: 'a' });
    await t.cleanupOlderThan(123);
    await t.cleanupOwn('uid-1');
    expect(inner.send).toHaveBeenCalledWith({ from: 'a' });
    expect(inner.cleanupOlderThan).toHaveBeenCalledWith(123);
    expect(inner.cleanupOwn).toHaveBeenCalledWith('uid-1');
  });

  it('載入失敗不炸呼叫端的 subscribe（連線逾時才是該報錯的地方）', async () => {
    const t = createLazySignalingTransport(() => Promise.reject(new Error('import failed')));
    expect(() => t.subscribe(0, () => {})).not.toThrow();
    await Promise.resolve();
    await Promise.resolve();
  });
});
