/**
 * antiEntropy 驗證邊界——殺 Stryker mutation 存活者
 *
 * mutation 測試發現 normalizeDigest 的逐條驗證分支、peerLacks 的 floor 守衛未被
 * 現有測試覆蓋（改壞了測試卻沒紅）。這裡逐條釘住，讓惡意/畸形 digest 的每一種
 * 拒絕理由都有測試守著。
 *
 * @vitest-environment node
 */
import { describe, it, expect } from 'vitest';
import { normalizeDigest, peerLacks, type NormalizedDigest } from '../../src/core/mesh/antiEntropy';

const validEntry = { floor: 1, max: 3, missing: [2] };

describe('normalizeDigest — 逐條驗證拒絕（殺 mutant）', () => {
  it('合法 digest 正規化成功', () => {
    expect(normalizeDigest({ N0: validEntry })).not.toBeNull();
  });

  // 每個案例違反「一條」規則，其餘合法 → 精準釘住該分支
  const rejects: Array<[string, unknown]> = [
    ['raw 非物件（字串）', 'x'],
    ['raw 為 null', null],
    ['raw 為陣列', [validEntry]],
    ['value 非物件', { N0: 42 }],
    ['value 為 null', { N0: null }],
    ['floor 非數字', { N0: { ...validEntry, floor: '1' } }],
    ['floor 非整數', { N0: { ...validEntry, floor: 1.5 } }],
    ['floor < 1', { N0: { ...validEntry, floor: 0 } }],
    ['max 非數字', { N0: { ...validEntry, max: '3' } }],
    ['max 非整數', { N0: { ...validEntry, max: 3.5 } }],
    ['max < 0', { N0: { ...validEntry, max: -1 } }],
    ['missing 非陣列', { N0: { ...validEntry, missing: 'x' } }],
    ['missing 含非數字', { N0: { ...validEntry, missing: ['x'] } }],
    ['missing 含非整數', { N0: { ...validEntry, missing: [2.5] } }],
  ];
  for (const [name, input] of rejects) {
    it(`拒絕：${name} → null`, () => {
      expect(normalizeDigest(input)).toBeNull();
    });
  }

  it('過多 sender → null（擋巨型 digest）', () => {
    const big: Record<string, typeof validEntry> = {};
    for (let i = 0; i < 100; i++) big[`N${i}`] = validEntry;
    expect(normalizeDigest(big)).toBeNull();
  });

  it('missing 過長 → null', () => {
    const longMissing = Array.from({ length: 600 }, (_, i) => i + 1);
    expect(normalizeDigest({ N0: { floor: 1, max: 700, missing: longMissing } })).toBeNull();
  });
});

describe('peerLacks — floor 守衛（殺 mutant）', () => {
  function digest(floor: number, max: number, missing: number[]): NormalizedDigest {
    return new Map([['N', { floor, max, missing: new Set(missing) }]]);
  }

  it('seq < floor → 不缺（對方主動遺忘，不回補）——即使 missing 誤含該 seq', () => {
    // floor 守衛必須先於 missing 查詢：seq=3 < floor=5，即便 missing 含 3 也回 false
    const d = digest(5, 10, [3]);
    expect(peerLacks(d, 'N', 3)).toBe(false); // mutant「if(false)」會誤回 true → 被殺
  });

  it('seq > max → 缺', () => {
    expect(peerLacks(digest(1, 5, []), 'N', 6)).toBe(true);
  });

  it('floor..max 內、在 missing → 缺；不在 → 不缺', () => {
    const d = digest(1, 5, [3]);
    expect(peerLacks(d, 'N', 3)).toBe(true);
    expect(peerLacks(d, 'N', 2)).toBe(false);
  });

  it('對方沒聽過此 sender → 全缺', () => {
    expect(peerLacks(digest(1, 5, []), 'UNKNOWN', 1)).toBe(true);
  });
});
