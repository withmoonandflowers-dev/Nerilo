import { describe, expect, it } from 'vitest';
import { CourierQualityStore } from '../../src/core/relay/CourierQuality';

describe('CourierQualityStore', () => {
  it('第一輪 A 連不上、B 對帳失敗、C 成功後，第二輪把 C 排在最前', () => {
    let now = 1_000;
    const quality = new CourierQualityStore(() => now);

    quality.recordConnection('A', false, 200);
    now += 100;
    quality.recordConnection('B', true, 80);
    quality.recordReconcile('B', false);
    now += 100;
    quality.recordConnection('C', true, 40);
    quality.recordReconcile('C', true);

    expect(quality.rankCandidates(['A', 'B', 'C'])).toEqual(['C', 'B', 'A']);
    expect(quality.getScore('C')).toBeGreaterThan(quality.getScore('B'));
    expect(quality.getScore('B')).toBeGreaterThan(quality.getScore('A'));
  });

  it('未知候選視為中性，同分維持 directory 原順序', () => {
    const quality = new CourierQualityStore(() => 1_000);
    expect(quality.rankCandidates(['directory-b', 'directory-a'])).toEqual([
      'directory-b',
      'directory-a',
    ]);
  });

  it('成功期間累積本地連續可達時長，任一失敗即歸零並累加失敗次數', () => {
    let now = 1_000;
    const quality = new CourierQualityStore(() => now);
    quality.recordConnection('courier', true, 25);
    now = 4_000;
    quality.recordReconcile('courier', true);
    expect(quality.get('courier')?.continuousReachableMs).toBe(3_000);

    quality.recordConnection('courier', false, 100);
    expect(quality.get('courier')).toMatchObject({
      continuousReachableMs: 0,
      consecutiveFailures: 1,
      lastConnectionSucceeded: false,
    });
  });
});
