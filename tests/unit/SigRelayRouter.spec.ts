/**
 * SigRelayRouter + WarmColdSignalingTransport 測試（Spec 005 T3）。
 *
 * 路由器（hop-by-hop ACK/NACK、hop 上限、回放緩衝）與選擇器（warm 優先、
 * 無路退 cold、退了黏住）的行為證明。三節點 A—B—C 記憶體鏈路（A、C 不直連）。
 *
 * @vitest-environment node
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { SigRelayRouter, type SigRelayLink, type SigRelayWire } from '../../src/core/p2p/SigRelayRouter';
import { WarmColdSignalingTransport } from '../../src/core/p2p/WarmColdSignalingTransport';
import type { SignalEnvelope } from '../../src/core/p2p/SignalEnvelope';
import type { RawSignalDoc, SignalingTransport } from '../../src/core/p2p/SignalingTransport.types';

// ── 記憶體雙向鏈路：一對 link，各自 send 觸發對方 onWire ─────────────────────
function linkPair(): [SigRelayLink, SigRelayLink] {
  const mk = (): { link: SigRelayLink; handlers: Set<(w: SigRelayWire) => void>; open: { v: boolean } } => {
    const handlers = new Set<(w: SigRelayWire) => void>();
    const open = { v: true };
    const link: SigRelayLink = {
      isOpen: () => open.v,
      // send 由 pair 接線時補上
      send: async () => { throw new Error('unwired'); },
      onWire: (h) => { handlers.add(h); return () => handlers.delete(h); },
    };
    return { link, handlers, open };
  };
  const a = mk();
  const b = mk();
  a.link.send = async (w) => {
    if (!a.open.v) throw new Error('closed');
    // 模擬非同步遞送（真 DataChannel 是非同步的）
    await Promise.resolve();
    b.handlers.forEach((h) => h(w));
  };
  b.link.send = async (w) => {
    if (!b.open.v) throw new Error('closed');
    await Promise.resolve();
    a.handlers.forEach((h) => h(w));
  };
  // 讓測試能關 link
  (a.link as SigRelayLink & { _open: { v: boolean } })._open = a.open;
  (b.link as SigRelayLink & { _open: { v: boolean } })._open = b.open;
  return [a.link, b.link];
}

function env(from: string, to: string, nonce: string): SignalEnvelope {
  return {
    v: 'nsig1', from, to, room: 'r', kind: 'offer',
    epoch: 0, ts: 1, nonce, ct: 'Y3Q=', iv: 'aXY=', sig: 'c2ln',
  };
}

// 拓樸 A—B—C：B 是中間人
let A: SigRelayRouter, B: SigRelayRouter, C: SigRelayRouter;

beforeEach(() => {
  A = new SigRelayRouter('A');
  B = new SigRelayRouter('B');
  C = new SigRelayRouter('C');
  const [ab, ba] = linkPair();
  const [bc, cb] = linkPair();
  A.attachNeighbor('B', ab);
  B.attachNeighbor('A', ba);
  B.attachNeighbor('C', bc);
  C.attachNeighbor('B', cb);
});

describe('SigRelayRouter — 遞送與 ACK', () => {
  it('直連：A→B 一跳送達並 ACK（relay resolve）', async () => {
    const got: SignalEnvelope[] = [];
    B.onInbound((e) => { got.push(e); });
    await A.relay(env('A', 'B', 'n1'));
    expect(got.map((e) => e.nonce)).toEqual(['n1']);
  });

  it('介紹人：A→(B 中繼)→C 送達；B 只轉發不吞', async () => {
    const got: SignalEnvelope[] = [];
    C.onInbound((e) => { got.push(e); });
    await A.relay(env('A', 'C', 'n2'));
    await new Promise((r) => setTimeout(r, 0));
    expect(got.map((e) => e.nonce)).toEqual(['n2']);
  });

  it('無路：目標不存在 → NACK → relay reject（上層退 Firestore 的訊號）', async () => {
    await expect(A.relay(env('A', 'Z', 'n3'))).rejects.toThrow(/無暖路徑|NACK/);
  });

  it('hop 上限：已中繼一跳的信封不再擴散（防洪泛）', async () => {
    // C 收到 hops=1 但 to=A 的信封（想騙 C 再轉一跳）→ C 應 NACK 而非轉發
    const got: SignalEnvelope[] = [];
    A.onInbound((e) => { got.push(e); });
    // 從 B 直接對 C 灌一則 hops=1、to=A 的 wire（模擬繞遠路企圖）
    const bcLink = (B as unknown as { links: Map<string, { link: SigRelayLink }> }).links.get('C')!.link;
    await bcLink.send({ kind: 'env', env: env('B', 'A', 'n4'), hops: 1 });
    await new Promise((r) => setTimeout(r, 5));
    expect(got).toHaveLength(0); // C 沒把它轉回 A
  });

  it('回放緩衝：信封先到、訂閱後補收（鏡像 Firestore lookback）', async () => {
    await A.relay(env('A', 'B', 'n5')); // B 此時無訂閱者
    const got: SignalEnvelope[] = [];
    B.onInbound((e) => { got.push(e); }); // 晚訂閱
    expect(got.map((e) => e.nonce)).toEqual(['n5']);
  });

  it('畸形 wire（不可信 peer）：不炸、不轉發', async () => {
    const bad = [null, 42, {}, { kind: 'env' }, { kind: 'env', env: {}, hops: 0 }, { kind: 'ack' }];
    const abLink = (A as unknown as { links: Map<string, { link: SigRelayLink }> }).links.get('B')!.link;
    for (const w of bad) {
      await abLink.send(w as SigRelayWire); // A→B 灌畸形 wire 給 B
    }
    await new Promise((r) => setTimeout(r, 5));
    // B 還活著、正常信封照走
    const got: SignalEnvelope[] = [];
    B.onInbound((e) => { got.push(e); });
    await A.relay(env('A', 'B', 'n6'));
    expect(got.map((e) => e.nonce)).toEqual(['n6']);
  });
});

// ── WarmColdSignalingTransport ────────────────────────────────────────────────
function fakeTransport(name: string, log: string[], failSend = false): SignalingTransport {
  return {
    subscribe: (_c, _h) => { log.push(`${name}:sub`); return () => log.push(`${name}:unsub`); },
    send: async (d) => {
      if (failSend) throw new Error(`${name} send fail`);
      log.push(`${name}:send:${d.type as string}`);
    },
    cleanupOlderThan: async () => { log.push(`${name}:cleanOld`); },
    cleanupOwn: async () => { log.push(`${name}:cleanOwn`); },
  };
}

describe('WarmColdSignalingTransport — 三態選路', () => {
  it('有暖路徑：send 走 warm，cold 零寫入', async () => {
    const log: string[] = [];
    const t = new WarmColdSignalingTransport(
      fakeTransport('warm', log),
      () => fakeTransport('cold', log),
      () => true,
      'test'
    );
    await t.send({ type: 'offer' });
    await t.send({ type: 'ice' });
    expect(log).toEqual(['warm:send:offer', 'warm:send:ice']); // cold 完全沒被碰
  });

  it('無暖路徑：send 直接走 cold', async () => {
    const log: string[] = [];
    const t = new WarmColdSignalingTransport(
      fakeTransport('warm', log),
      () => fakeTransport('cold', log),
      () => false,
      'test'
    );
    await t.send({ type: 'offer' });
    expect(log).toEqual(['cold:send:offer']);
  });

  it('warm 失敗：退 cold 並黏住（後續不再重試 warm）', async () => {
    const log: string[] = [];
    const t = new WarmColdSignalingTransport(
      fakeTransport('warm', log, /* failSend */ true),
      () => fakeTransport('cold', log),
      () => true,
      'test'
    );
    await t.send({ type: 'offer' });
    await t.send({ type: 'ice' });
    expect(log).toEqual(['cold:send:offer', 'cold:send:ice']);
  });

  it('warm 為 null（無對端 uid）：純 cold', async () => {
    const log: string[] = [];
    const t = new WarmColdSignalingTransport(null, () => fakeTransport('cold', log), () => true, 'test');
    await t.send({ type: 'offer' });
    expect(log).toEqual(['cold:send:offer']);
  });

  it('subscribe 兩路同訂、退訂兩路都退', async () => {
    const log: string[] = [];
    const t = new WarmColdSignalingTransport(
      fakeTransport('warm', log),
      () => fakeTransport('cold', log),
      () => true,
      'test'
    );
    const unsub = t.subscribe(0, () => {});
    await new Promise((r) => setTimeout(r, 0)); // cold 延遲建立
    unsub();
    expect(log).toEqual(['warm:sub', 'cold:sub', 'warm:unsub', 'cold:unsub']);
  });

  it('cleanup 只碰已建立的 cold（別為清理特地建立）', async () => {
    const log: string[] = [];
    const t = new WarmColdSignalingTransport(
      fakeTransport('warm', log),
      () => fakeTransport('cold', log),
      () => true,
      'test'
    );
    await t.cleanupOlderThan(0);
    await t.cleanupOwn('me');
    expect(log).toEqual([]); // cold 未建立 → 無事發生
  });
});

// ── 端到端小整合：router + warm/cold，暖路徑成功時 cold 零寫入 ─────────────────
describe('T3 整合 — warm 經介紹人送達、cold 零寫入', () => {
  it('A 的 signal 經 B 中繼到 C（假 warm transport 直接走 router），cold 未被寫', async () => {
    const coldLog: string[] = [];
    const gotAtC: RawSignalDoc[] = [];
    // 簡化 warm：直接把 data 包進 env 的 nonce 欄（本測驗路由，加密封拆由 T2 spec 覆蓋）
    const warmViaRouter: SignalingTransport = {
      subscribe: (_c, onAdded) =>
        C.onInbound((e) => onAdded({ signalId: e.nonce, from: e.from, type: e.kind, payload: null })) ,
      send: async (d) => { await A.relay(env('A', 'C', `sig-${d.type as string}`)); },
      cleanupOlderThan: async () => {},
      cleanupOwn: async () => {},
    };
    // C 側先訂閱（模擬 manager setupSignalingListeners）
    const selector = new WarmColdSignalingTransport(
      warmViaRouter,
      () => fakeTransport('cold', coldLog),
      () => A['hasOpenNeighbors'](),
      'mesh-A-C'
    );
    warmViaRouter.subscribe(0, (raw) => gotAtC.push(raw));
    await selector.send({ type: 'offer' });
    await new Promise((r) => setTimeout(r, 5));
    expect(gotAtC.map((r) => r.signalId)).toEqual(['sig-offer']);
    expect(coldLog).toEqual([]); // 介紹路徑成功 → Firestore 零寫入
  });
});
