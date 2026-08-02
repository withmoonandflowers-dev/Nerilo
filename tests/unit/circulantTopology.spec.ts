/**
 * Spec 016 T2：確定性互選拓撲的性質證明。
 * 互選對稱性是整個成形修復的立足點——property test 覆蓋任意名冊，
 * 連通性與度數界則對 n≤12 全枚舉。
 */
import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { computeCirculantTargets } from '../../src/core/mesh/circulantTopology';

/** 由全體節點的目標集組出無向圖，BFS 檢查連通 */
function isConnected(roster: string[], k: number): boolean {
  if (roster.length <= 1) return true;
  const adj = new Map<string, Set<string>>(roster.map((id) => [id, new Set()]));
  for (const id of roster) {
    for (const t of computeCirculantTargets(roster, id, k)) {
      adj.get(id)!.add(t);
      adj.get(t)?.add(id);
    }
  }
  const seen = new Set<string>([roster[0]!]);
  const queue = [roster[0]!];
  while (queue.length) {
    for (const nb of adj.get(queue.shift()!)!) {
      if (!seen.has(nb)) { seen.add(nb); queue.push(nb); }
    }
  }
  return seen.size === roster.length;
}

const uniqueRosterArb = fc
  .uniqueArray(fc.hexaString({ minLength: 4, maxLength: 12 }), { minLength: 2, maxLength: 12 })
  .filter((ids) => new Set(ids).size === ids.length);

describe('computeCirculantTargets（Spec 016）', () => {
  it('property：互選對稱——任意名冊與 k，b 在 a 的目標集 ⟺ a 在 b 的目標集', () => {
    fc.assert(
      fc.property(uniqueRosterArb, fc.integer({ min: 1, max: 6 }), (roster, k) => {
        for (const a of roster) {
          const ta = computeCirculantTargets(roster, a, k);
          for (const b of ta) {
            const tb = computeCirculantTargets(roster, b, k);
            if (!tb.includes(a)) return false;
          }
        }
        return true;
      }),
      { numRuns: 300 }
    );
  });

  it('property：決定性且與名冊傳入順序無關；不含自己', () => {
    fc.assert(
      fc.property(uniqueRosterArb, fc.integer({ min: 1, max: 6 }), (roster, k) => {
        const self = roster[0]!;
        const shuffled = [...roster].reverse();
        const t1 = computeCirculantTargets(roster, self, k);
        const t2 = computeCirculantTargets(shuffled, self, k);
        return JSON.stringify(t1) === JSON.stringify(t2) && !t1.includes(self);
      }),
      { numRuns: 200 }
    );
  });

  it('連通性：n=2..12 × k=3..4 全枚舉，全體目標集組成的圖必連通', () => {
    for (let n = 2; n <= 12; n++) {
      const roster = Array.from({ length: n }, (_, j) => `u${String(j).padStart(2, '0')}`);
      for (const k of [3, 4]) {
        expect(isConnected(roster, k), `n=${n} k=${k}`).toBe(true);
      }
    }
  });

  it('full mesh 檔（k ≥ n-1）：回傳全體其他人（≤6 人房行為不變）', () => {
    for (let n = 2; n <= 6; n++) {
      const roster = Array.from({ length: n }, (_, j) => `u${j}`);
      const targets = computeCirculantTargets(roster, 'u0', 6);
      expect(targets.sort()).toEqual(roster.slice(1).sort());
    }
  });

  it('partial 檔度數界：|targets| ≤ 2⌈k/2⌉；7..10 人 × k=3..4 具體值', () => {
    for (let n = 7; n <= 10; n++) {
      const roster = Array.from({ length: n }, (_, j) => `u${String(j).padStart(2, '0')}`);
      for (const k of [3, 4]) {
        for (const id of roster) {
          const t = computeCirculantTargets(roster, id, k);
          expect(t.length).toBeLessThanOrEqual(2 * Math.ceil(k / 2));
          expect(t.length).toBeGreaterThanOrEqual(Math.min(n - 1, 2));
        }
      }
    }
  });

  it('名冊未含自己時視為 roster ∪ {self}（identityMap 落後自身註冊的防禦）', () => {
    const roster = ['u1', 'u2', 'u3', 'u4', 'u5', 'u6', 'u7'];
    const withSelf = computeCirculantTargets([...roster, 'u0'], 'u0', 3);
    const withoutSelf = computeCirculantTargets(roster, 'u0', 3);
    expect(withoutSelf).toEqual(withSelf);
  });

  it('退化輸入：單人、k=0 回空集', () => {
    expect(computeCirculantTargets(['me'], 'me', 3)).toEqual([]);
    expect(computeCirculantTargets(['me', 'you'], 'me', 0)).toEqual([]);
  });
});
