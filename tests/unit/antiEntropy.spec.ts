/**
 * antiEntropy 純函數測試 + 收斂性模擬
 *
 * 核心保證：digest 交換一輪後兩節點的對稱差嚴格縮小；訊息集有限 →
 * 週期交換下必然收斂（每則訊息最終各恰好一次）。模擬測試直接驗證此性質。
 */
import { describe, it, expect } from 'vitest';
import {
  computeDigest,
  normalizeDigest,
  peerLacks,
  type GossipDigest,
} from '../../src/core/mesh/antiEntropy';
import type { GossipMessage } from '../../src/types';

function msg(senderId: string, seq: number): GossipMessage {
  return {
    roomId: 'r',
    senderId,
    pubKey: 'pk',
    seq,
    timestamp: seq,
    content: `${senderId}-${seq}`,
    ttl: 8,
    signature: 'sig',
  };
}

function makeStore(entries: Array<[string, number[]]>): Map<string, Map<number, GossipMessage>> {
  const store = new Map<string, Map<number, GossipMessage>>();
  for (const [sender, seqs] of entries) {
    store.set(sender, new Map(seqs.map((s) => [s, msg(sender, s)])));
  }
  return store;
}

describe('computeDigest', () => {
  it('連續 seq：missing 為空', () => {
    const d = computeDigest(makeStore([['a', [1, 2, 3]]]), new Map());
    expect(d).toEqual({ a: { floor: 1, max: 3, missing: [] } });
  });

  it('有缺口：missing 列出 [floor..max] 中未持有的 seq', () => {
    const d = computeDigest(makeStore([['a', [1, 4, 5]]]), new Map());
    expect(d['a']).toEqual({ floor: 1, max: 5, missing: [2, 3] });
  });

  it('尊重 floor：floor 前的缺口不列入 missing', () => {
    const d = computeDigest(makeStore([['a', [4, 5]]]), new Map([['a', 4]]));
    expect(d['a']).toEqual({ floor: 4, max: 5, missing: [] });
  });
});

describe('normalizeDigest / peerLacks', () => {
  it('合法 digest 正規化後可查詢', () => {
    const n = normalizeDigest({ a: { floor: 1, max: 5, missing: [2] } });
    expect(n).not.toBeNull();
    expect(peerLacks(n!, 'a', 2)).toBe(true); // 在 missing
    expect(peerLacks(n!, 'a', 3)).toBe(false); // 持有
    expect(peerLacks(n!, 'a', 6)).toBe(true); // 超過 max
    expect(peerLacks(n!, 'b', 1)).toBe(true); // 沒聽過的 sender 全缺
  });

  it('floor 前的 seq 視為對方主動遺忘，不回補', () => {
    const n = normalizeDigest({ a: { floor: 10, max: 12, missing: [] } });
    expect(peerLacks(n!, 'a', 5)).toBe(false);
  });

  it('畸形輸入回傳 null', () => {
    expect(normalizeDigest(null)).toBeNull();
    expect(normalizeDigest('x')).toBeNull();
    expect(normalizeDigest([1])).toBeNull();
    expect(normalizeDigest({ a: { floor: 0, max: 1, missing: [] } })).toBeNull(); // floor < 1
    expect(normalizeDigest({ a: { floor: 1, max: 1.5, missing: [] } })).toBeNull();
    expect(normalizeDigest({ a: { floor: 1, max: 1, missing: ['x'] } })).toBeNull();
    expect(normalizeDigest({ a: { floor: 1, max: 1 } })).toBeNull(); // 缺 missing
  });
});

describe('收斂性模擬：週期 digest 交換使所有節點達到一致', () => {
  /** 極簡節點：store + 依對方 digest 補送 */
  class SimNode {
    store = new Map<string, Map<number, GossipMessage>>();

    put(m: GossipMessage): void {
      let seqs = this.store.get(m.senderId);
      if (!seqs) {
        seqs = new Map();
        this.store.set(m.senderId, seqs);
      }
      seqs.set(m.seq, m);
    }

    digest(): GossipDigest {
      return computeDigest(this.store, new Map());
    }

    /** 收到 peer 的 digest：把對方缺的推過去（鏡射 handleDigest 的核心邏輯） */
    fillTo(peer: SimNode): void {
      const theirs = normalizeDigest(peer.digest())!;
      for (const [sender, seqs] of this.store) {
        for (const [seq, m] of seqs) {
          if (peerLacks(theirs, sender, seq)) peer.put(m);
        }
      }
    }

    holdings(): string[] {
      const all: string[] = [];
      for (const [sender, seqs] of this.store) {
        for (const seq of seqs.keys()) all.push(`${sender}:${seq}`);
      }
      return all.sort();
    }
  }

  it('3 節點、亂序與部分遺失下，兩輪成對交換後全員一致', () => {
    const [a, b, c] = [new SimNode(), new SimNode(), new SimNode()];
    // 初始亂況：A 有自己的 1,2；B 只拿到 A 的 2（先到）與自己的 1；C 什麼都沒收到
    a.put(msg('A', 1));
    a.put(msg('A', 2));
    b.put(msg('A', 2));
    b.put(msg('B', 1));
    c.put(msg('C', 1));

    const pairs: Array<[SimNode, SimNode]> = [
      [a, b],
      [b, c],
      [a, c],
    ];
    // 兩輪成對雙向對帳（直徑 2 的連通圖，兩輪足夠）
    for (let round = 0; round < 2; round++) {
      for (const [x, y] of pairs) {
        x.fillTo(y);
        y.fillTo(x);
      }
    }

    const expected = ['A:1', 'A:2', 'B:1', 'C:1'];
    expect(a.holdings()).toEqual(expected);
    expect(b.holdings()).toEqual(expected);
    expect(c.holdings()).toEqual(expected);
  });

  it('鏈狀拓撲（A-B-C，A、C 不相鄰）也收斂：補償走任何路徑', () => {
    const [a, b, c] = [new SimNode(), new SimNode(), new SimNode()];
    a.put(msg('A', 1));
    c.put(msg('C', 1));

    // 只有 A-B 與 B-C 有連線；輪數 = 圖直徑即可
    for (let round = 0; round < 2; round++) {
      a.fillTo(b);
      b.fillTo(a);
      b.fillTo(c);
      c.fillTo(b);
    }

    const expected = ['A:1', 'C:1'];
    expect(a.holdings()).toEqual(expected);
    expect(b.holdings()).toEqual(expected);
    expect(c.holdings()).toEqual(expected);
  });
});
