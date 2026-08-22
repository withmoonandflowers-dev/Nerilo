/**
 * M-7：TURN 憑證配額純邏輯。
 *
 * getIceServers 此前只檢查「有沒有登入」——匿名登入即可通過，且無速率限制，
 * 攻擊者可大量建匿名帳號無限索取 Twilio TURN 憑證（TURN 中繼流量按量計費）。
 *
 * @vitest-environment node
 */
import { describe, it, expect } from 'vitest';
import { decideQuota } from '../../functions/src/quota-core';

const WINDOW = 60 * 60 * 1000;
const MAX = 60;

describe('decideQuota（M-7 固定視窗計數）', () => {
  it('首次呼叫（無既有狀態）→ 放行並開新視窗', () => {
    const d = decideQuota(undefined, 1_000_000, WINDOW, MAX);
    expect(d.allowed).toBe(true);
    expect(d.state).toEqual({ windowStart: 1_000_000, count: 1 });
  });

  it('視窗內未達上限 → 放行並累加', () => {
    const d = decideQuota({ windowStart: 1_000_000, count: 5 }, 1_000_500, WINDOW, MAX);
    expect(d.allowed).toBe(true);
    expect(d.state).toEqual({ windowStart: 1_000_000, count: 6 });
  });

  it('視窗內達上限 → 拒絕', () => {
    const d = decideQuota({ windowStart: 1_000_000, count: MAX }, 1_000_500, WINDOW, MAX);
    expect(d.allowed).toBe(false);
  });

  it('拒絕時不累加、也不延長視窗（避免被打成永久封鎖）', () => {
    const state = { windowStart: 1_000_000, count: MAX + 10 };
    const d = decideQuota(state, 1_000_500, WINDOW, MAX);
    expect(d.allowed).toBe(false);
    expect(d.state).toEqual(state);
  });

  it('視窗過期 → 重新開窗並放行', () => {
    const d = decideQuota({ windowStart: 1_000_000, count: MAX }, 1_000_000 + WINDOW, WINDOW, MAX);
    expect(d.allowed).toBe(true);
    expect(d.state).toEqual({ windowStart: 1_000_000 + WINDOW, count: 1 });
  });

  it('連續耗用：第 MAX 次仍放行，第 MAX+1 次起被擋', () => {
    let state: { windowStart: number; count: number } | undefined;
    let allowedCount = 0;
    for (let i = 0; i < MAX + 5; i++) {
      const d = decideQuota(state, 2_000_000 + i, WINDOW, MAX);
      if (d.allowed) allowedCount++;
      state = d.state;
    }
    expect(allowedCount).toBe(MAX);
  });

  it('畸形既有狀態（欄位型別不符）視為全新視窗，不因此擋住正當使用者', () => {
    const d = decideQuota({ windowStart: NaN as unknown as number, count: 'x' as unknown as number }, 5_000, WINDOW, MAX);
    expect(d.allowed).toBe(true);
  });
});
