/**
 * B5：keyx 受阻警告的判定（每個原因只吼一次，避免 4s tick 洗版）。
 *
 * @vitest-environment node
 */
import { describe, it, expect } from 'vitest';
import { decideStuckWarning, KEYX_NOT_BLOCKED } from '../../src/core/mesh/keyxStuckWarning';
import type { KeyxStatus } from '../../src/core/mesh/RoomKeyCoordinator';

const TIMEOUT = 60_000;
const blocked = (ms: number): KeyxStatus => ({
  reason: 'awaiting-members',
  pendingMembers: 1,
  blockedForMs: ms,
});

describe('decideStuckWarning（B5）', () => {
  it('未被擋 → 不吼，並清空已吼記錄（日後復發還能再吼）', () => {
    const d = decideStuckWarning(KEYX_NOT_BLOCKED, 'awaiting-members', TIMEOUT);
    expect(d).toEqual({ warn: false, nextWarnedReason: null });
  });

  it('受阻但未達逾時線 → 不吼', () => {
    expect(decideStuckWarning(blocked(30_000), null, TIMEOUT).warn).toBe(false);
  });

  it('受阻超過逾時線且尚未吼過 → 吼一次並記錄', () => {
    const d = decideStuckWarning(blocked(61_000), null, TIMEOUT);
    expect(d).toEqual({ warn: true, nextWarnedReason: 'awaiting-members' });
  });

  it('同一原因不重複吼（4s tick 不洗版）', () => {
    const d = decideStuckWarning(blocked(120_000), 'awaiting-members', TIMEOUT);
    expect(d.warn).toBe(false);
  });

  it('換成另一個原因 → 重新吼一次', () => {
    const s: KeyxStatus = { reason: 'roster-unstable', pendingMembers: 0, blockedForMs: 61_000 };
    const d = decideStuckWarning(s, 'awaiting-members', TIMEOUT);
    expect(d).toEqual({ warn: true, nextWarnedReason: 'roster-unstable' });
  });

  it('先解除再復發 → 記錄已清空，可再吼', () => {
    const cleared = decideStuckWarning(KEYX_NOT_BLOCKED, 'awaiting-members', TIMEOUT);
    const again = decideStuckWarning(blocked(61_000), cleared.nextWarnedReason, TIMEOUT);
    expect(again.warn).toBe(true);
  });
});
