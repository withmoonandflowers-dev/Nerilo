/**
 * antiEntropy 純函數測試 + 收斂性模擬（Spec 009 起分代）
 *
 * 核心保證：同代之內 digest 交換一輪後兩節點的對稱差嚴格縮小；訊息集有限 →
 * 週期交換下必然收斂（每則訊息最終各恰好一次）。跨代由「新代紀錄單向推進
 * 舊代持有者」收斂到全員現行代聯集。模擬測試直接驗證此性質。
 */
import { describe, it, expect } from 'vitest';
import {
  computeDigest,
  normalizeDigest,
  peerLacks,
  maxEpochs,
  type GossipDigest,
} from '../../src/core/mesh/antiEntropy';
import type { GossipMessage } from '../../src/types';

function msg(senderId: string, seq: number, sessionEpoch = 1): GossipMessage {
  return {
    roomId: 'r',
    senderId,
    pubKey: 'pk',
    seq,
    sessionEpoch,
    timestamp: seq,
    content: `${senderId}-${sessionEpoch}-${seq}`,
    ttl: 8,
    signature: 'sig',
  };
}

type EpochStoreMut = Map<string, Map<number, Map<number, GossipMessage>>>;

function makeStore(entries: Array<[string, number[]]>, epoch = 1): EpochStoreMut {
  const store: EpochStoreMut = new Map();
  for (const [sender, seqs] of entries) {
    store.set(
      sender,
      new Map([[epoch, new Map(seqs.map((s) => [s, msg(sender, s, epoch)]))]]),
    );
  }
  return store;
}

function floorsOf(entries: Array<[string, number, number]>): Map<string, Map<number, number>> {
  const floors = new Map<string, Map<number, number>>();
  for (const [sender, epoch, floor] of entries) {
    let byEpoch = floors.get(sender);
    if (!byEpoch) floors.set(sender, (byEpoch = new Map()));
    byEpoch.set(epoch, floor);
  }
  return floors;
}

describe('computeDigest（分代）', () => {
  it('連續 seq：missing 為空、條目帶現行代', () => {
    const store = makeStore([['a', [1, 2, 3]]]);
    const d = computeDigest(store, new Map(), maxEpochs(store));
    expect(d).toEqual({ a: { epoch: 1, floor: 1, max: 3, missing: [] } });
  });

  it('有缺口：missing 列出 [floor..max] 中未持有的 seq', () => {
    const store = makeStore([['a', [1, 4, 5]]]);
    const d = computeDigest(store, new Map(), maxEpochs(store));
    expect(d['a']).toEqual({ epoch: 1, floor: 1, max: 5, missing: [2, 3] });
  });

  it('尊重 floor：floor 前的缺口不列入 missing', () => {
    const store = makeStore([['a', [4, 5]]]);
    const d = computeDigest(store, floorsOf([['a', 1, 4]]), maxEpochs(store));
    expect(d['a']).toEqual({ epoch: 1, floor: 4, max: 5, missing: [] });
  });

  it('只宣告現行代：舊代與 legacy（0 代）桶不出現在 digest', () => {
    const store: EpochStoreMut = new Map([
      ['a', new Map([
        [0, new Map([[1, msg('a', 1, 0)]])], // legacy
        [3, new Map([[1, msg('a', 1, 3)]])], // 舊代
        [7, new Map([[1, msg('a', 1, 7)], [2, msg('a', 2, 7)]])], // 現行代
      ])],
    ]);
    const d = computeDigest(store, new Map(), new Map([['a', 7]]));
    expect(d).toEqual({ a: { epoch: 7, floor: 1, max: 2, missing: [] } });
  });

  it('無宣告代的 sender（僅 legacy 持有）整個不宣告', () => {
    const store: EpochStoreMut = new Map([
      ['a', new Map([[0, new Map([[1, msg('a', 1, 0)]])]])],
    ]);
    expect(computeDigest(store, new Map(), maxEpochs(store))).toEqual({});
  });
});

describe('normalizeDigest / peerLacks（分代）', () => {
  it('合法 digest 正規化後可查詢', () => {
    const n = normalizeDigest({ a: { epoch: 5, floor: 1, max: 5, missing: [2] } });
    expect(n).not.toBeNull();
    expect(peerLacks(n!, 'a', 5, 2)).toBe(true); // 在 missing
    expect(peerLacks(n!, 'a', 5, 3)).toBe(false); // 持有
    expect(peerLacks(n!, 'a', 5, 6)).toBe(true); // 超過 max
    expect(peerLacks(n!, 'b', 5, 1)).toBe(true); // 沒聽過的 sender 全缺
  });

  it('代際判定：對方代落後 → 全缺；對方代較新 → 不缺（我方過時不送）', () => {
    const n = normalizeDigest({ a: { epoch: 5, floor: 1, max: 9, missing: [] } })!;
    expect(peerLacks(n, 'a', 7, 1)).toBe(true); // 我持第 7 代，對方停在第 5 代 → 補送推進
    expect(peerLacks(n, 'a', 3, 1)).toBe(false); // 我持第 3 代（過時）→ 不送
  });

  it('floor 前的 seq 視為對方主動遺忘，不回補', () => {
    const n = normalizeDigest({ a: { epoch: 1, floor: 10, max: 12, missing: [] } });
    expect(peerLacks(n!, 'a', 1, 5)).toBe(false);
  });

  it('畸形輸入回傳 null', () => {
    expect(normalizeDigest(null)).toBeNull();
    expect(normalizeDigest('x')).toBeNull();
    expect(normalizeDigest([1])).toBeNull();
    expect(normalizeDigest({ a: { epoch: 1, floor: 0, max: 1, missing: [] } })).toBeNull(); // floor < 1
    expect(normalizeDigest({ a: { epoch: 1, floor: 1, max: 1.5, missing: [] } })).toBeNull();
    expect(normalizeDigest({ a: { epoch: 1, floor: 1, max: 1, missing: ['x'] } })).toBeNull();
    expect(normalizeDigest({ a: { epoch: 1, floor: 1, max: 1 } })).toBeNull(); // 缺 missing
    // v1 digest（缺 epoch）：fail-closed 整份拒（Spec 009 §4.3 版本相容）
    expect(normalizeDigest({ a: { floor: 1, max: 1, missing: [] } })).toBeNull();
    expect(normalizeDigest({ a: { epoch: 0, floor: 1, max: 1, missing: [] } })).toBeNull(); // 0 代不宣告
  });
});

describe('收斂性模擬：週期 digest 交換使所有節點達到一致', () => {
  /** 極簡節點：分代 store + 現行代門檻 + 依對方 digest 補送 */
  class SimNode {
    store: EpochStoreMut = new Map();
    accepted = new Map<string, number>();

    put(m: GossipMessage): void {
      const cur = this.accepted.get(m.senderId);
      if (cur !== undefined && m.sessionEpoch < cur) return; // 現行代門檻
      if (cur === undefined || m.sessionEpoch > cur) {
        this.accepted.set(m.senderId, m.sessionEpoch);
        const epochs = this.store.get(m.senderId);
        if (epochs) for (const ep of [...epochs.keys()]) if (ep < m.sessionEpoch) epochs.delete(ep);
      }
      let epochs = this.store.get(m.senderId);
      if (!epochs) this.store.set(m.senderId, (epochs = new Map()));
      let seqs = epochs.get(m.sessionEpoch);
      if (!seqs) epochs.set(m.sessionEpoch, (seqs = new Map()));
      seqs.set(m.seq, m);
    }

    digest(): GossipDigest {
      return computeDigest(this.store, new Map(), this.accepted);
    }

    /** 收到 peer 的 digest：把對方缺的推過去（鏡射 handleDigest 的核心邏輯） */
    fillTo(peer: SimNode): void {
      const theirs = normalizeDigest(peer.digest());
      if (!theirs) {
        // 對方 store 空（digest {} 合法）：全推
        for (const [sender, epoch] of this.accepted) {
          const seqs = this.store.get(sender)?.get(epoch);
          if (seqs) for (const m of seqs.values()) peer.put(m);
        }
        return;
      }
      for (const [sender, epoch] of this.accepted) {
        const seqs = this.store.get(sender)?.get(epoch);
        if (!seqs) continue;
        for (const [seq, m] of seqs) {
          if (peerLacks(theirs, sender, epoch, seq)) peer.put(m);
        }
      }
    }

    holdings(): string[] {
      const all: string[] = [];
      for (const [sender, epochs] of this.store) {
        for (const [epoch, seqs] of epochs) {
          for (const seq of seqs.keys()) all.push(`${sender}:${epoch}:${seq}`);
        }
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

    const expected = ['A:1:1', 'A:1:2', 'B:1:1', 'C:1:1'];
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

    const expected = ['A:1:1', 'C:1:1'];
    expect(a.holdings()).toEqual(expected);
    expect(b.holdings()).toEqual(expected);
    expect(c.holdings()).toEqual(expected);
  });

  it('代際切換：sender 換代後，持舊代者被推進到新代、舊代桶剪除（Spec 009）', () => {
    const [a, b] = [new SimNode(), new SimNode()];
    // B 持有 A 第 1 代的歷史；A（sender 本人重進）只持第 2 代
    b.put(msg('A', 1, 1));
    b.put(msg('A', 2, 1));
    a.put(msg('A', 1, 2));

    for (let round = 0; round < 2; round++) {
      a.fillTo(b);
      b.fillTo(a);
    }

    // 全員收斂到現行代聯集；第 1 代不會回流到 A（現行代門檻）
    expect(a.holdings()).toEqual(['A:2:1']);
    expect(b.holdings()).toEqual(['A:2:1']);
    expect(b.accepted.get('A')).toBe(2);
  });
});
