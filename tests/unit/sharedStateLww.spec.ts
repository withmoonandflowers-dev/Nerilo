import { describe, it, expect } from 'vitest';
import {
  applyDelta, applyBatch, exportDeltas, toView, compareStamp,
  type StateMap, type StateDelta,
} from '../../src/core/state/sharedStateLww';

const d = (k: string, v: unknown | undefined, wall: number, logical: number, from: string): StateDelta =>
  ({ k, ...(v === undefined ? {} : { v }), hlc: { wallTime: wall, logical, nodeId: from.slice(0, 8) }, from });

describe('共享狀態 LWW 核心（Spec 025 T1）', () => {
  it('裁決鍵：wallTime → logical → from 字典序', () => {
    expect(compareStamp({ hlc: { wallTime: 2, logical: 0, nodeId: 'a' }, from: 'a' },
                        { hlc: { wallTime: 1, logical: 9, nodeId: 'b' }, from: 'b' })).toBeGreaterThan(0);
    expect(compareStamp({ hlc: { wallTime: 1, logical: 2, nodeId: 'a' }, from: 'a' },
                        { hlc: { wallTime: 1, logical: 1, nodeId: 'b' }, from: 'b' })).toBeGreaterThan(0);
    expect(compareStamp({ hlc: { wallTime: 1, logical: 1, nodeId: 'a' }, from: 'zzz' },
                        { hlc: { wallTime: 1, logical: 1, nodeId: 'b' }, from: 'aaa' })).toBeGreaterThan(0);
  });

  it('LWW：新蓋舊、舊到不動、同筆冪等', () => {
    const m: StateMap = new Map();
    expect(applyDelta(m, d('score', 10, 100, 0, 'A'))).toBe(true);
    expect(applyDelta(m, d('score', 99, 200, 0, 'B'))).toBe(true);  // 新蓋舊
    expect(applyDelta(m, d('score', 50, 150, 0, 'A'))).toBe(false); // 舊到不動
    expect(applyDelta(m, d('score', 99, 200, 0, 'B'))).toBe(false); // 同筆冪等
    expect(toView(m)).toEqual({ score: 99 });
  });

  it('亂序收斂：兩端以不同順序套同一批增量，視圖一致', () => {
    const deltas = [
      d('a', 1, 100, 0, 'X'), d('a', 2, 100, 1, 'Y'), d('b', 'x', 90, 0, 'X'),
      d('b', undefined, 120, 0, 'Y'), d('c', [1, 2], 110, 0, 'X'),
    ];
    const m1: StateMap = new Map();
    const m2: StateMap = new Map();
    for (const x of deltas) applyDelta(m1, x);
    for (const x of [...deltas].reverse()) applyDelta(m2, x);
    expect(toView(m1)).toEqual(toView(m2));
    expect(toView(m1)).toEqual({ a: 2, c: [1, 2] }); // b 已刪
  });

  it('墓碑：刪除不被舊增量復活；匯出含墓碑讓晚進者也不復活', () => {
    const m: StateMap = new Map();
    applyDelta(m, d('k', 'v1', 100, 0, 'A'));
    applyDelta(m, d('k', undefined, 200, 0, 'B')); // 刪除
    expect(applyDelta(m, d('k', 'v-old', 150, 0, 'A'))).toBe(false); // 舊寫入不復活
    expect(toView(m)).toEqual({});

    // 晚進者從快照重建：墓碑要在匯出裡
    const late: StateMap = new Map();
    applyBatch(late, exportDeltas(m));
    expect(applyDelta(late, d('k', 'v-old', 150, 0, 'A'))).toBe(false);
    expect(toView(late)).toEqual({});
  });

  it('快照與增量交錯：晚進者先收增量再收快照（或反過來）皆收斂', () => {
    const src: StateMap = new Map();
    applyDelta(src, d('x', 1, 100, 0, 'A'));
    applyDelta(src, d('y', 2, 110, 0, 'B'));
    const snap = exportDeltas(src);
    const live = d('x', 9, 120, 0, 'B'); // 快照後的新增量

    const m1: StateMap = new Map(); // 先快照後增量
    applyBatch(m1, snap); applyDelta(m1, live);
    const m2: StateMap = new Map(); // 先增量後快照
    applyDelta(m2, live); applyBatch(m2, snap);
    expect(toView(m1)).toEqual(toView(m2));
    expect(toView(m1)).toEqual({ x: 9, y: 2 });
  });

  it('toView 深拷貝：突變回傳值不汙染內部', () => {
    const m: StateMap = new Map();
    applyDelta(m, d('obj', { list: [1] }, 100, 0, 'A'));
    const v = toView(m) as { obj: { list: number[] } };
    v.obj.list.push(999);
    expect(toView(m)).toEqual({ obj: { list: [1] } });
  });
});
