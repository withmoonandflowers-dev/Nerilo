/**
 * 遊戲座位純邏輯測試——座 0 恆房主、座 1 為最早 claim 的非房主、其餘觀戰。
 *
 * @vitest-environment node
 */
import { describe, it, expect } from 'vitest';
import { seat1Holder, seatRole, type SeatClaims } from '../../src/features/game/seats';

describe('seats', () => {
  it('房主永遠是 first（座 0），不看 wanting', () => {
    expect(seatRole({}, 'owner', 'owner')).toBe('first');
    expect(seatRole({ owner: 1 }, 'owner', 'owner')).toBe('first');
  });

  it('座 1 = 最早 claim 的非房主', () => {
    const w: SeatClaims = { bob: 200, carol: 100 };
    expect(seat1Holder(w, 'owner')).toBe('carol'); // 100 < 200
    expect(seatRole(w, 'owner', 'carol')).toBe('second');
    expect(seatRole(w, 'owner', 'bob')).toBe('spectator');
  });

  it('同時 claim（ts 相同）→ id 小者得座 1', () => {
    const w: SeatClaims = { zoe: 100, amy: 100 };
    expect(seat1Holder(w, 'owner')).toBe('amy');
  });

  it('房主即使在 wanting 中也被排除（恆座 0）', () => {
    const w: SeatClaims = { owner: 50, bob: 100 };
    expect(seat1Holder(w, 'owner')).toBe('bob');
  });

  it('沒人想玩 → 座 1 空、非房主皆觀戰', () => {
    expect(seat1Holder({}, 'owner')).toBeNull();
    expect(seatRole({}, 'owner', 'bob')).toBe('spectator');
  });

  it('座 1 持有者 release（從集合移除）→ 換最早的下一位', () => {
    let w: SeatClaims = { bob: 100, carol: 200 };
    expect(seat1Holder(w, 'owner')).toBe('bob');
    const { bob: _drop, ...rest } = w; void _drop; w = rest; // bob 離座
    expect(seat1Holder(w, 'owner')).toBe('carol');
  });
});
