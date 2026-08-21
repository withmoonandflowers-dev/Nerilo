/**
 * A6 回歸：FirestoreRoomDirectory.watchIdentities 在 onSnapshot error 後應有界退避重訂閱。
 *
 * 修復前：一次暫時性 error 就讓 mesh 唯一的名冊 push 通道永久靜止（成員發現／rejoin
 * 偵測／人數全停）且 UI 無感。修復後：error → 退避後重訂閱；成功快照重置退避；
 * permission-denied 這類永久錯誤由 MAX_RETRIES 上界收斂。
 *
 * @vitest-environment node
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../src/config/firebase', () => ({ db: {} }));
vi.mock('../../src/services/RoomService', () => ({ RoomService: {} }));

type Next = (snap: { exists: () => boolean; data: () => unknown }) => void;
type ErrCb = (e: unknown) => void;
const calls: Array<{ next: Next; error: ErrCb }> = [];
vi.mock('firebase/firestore', () => ({
  doc: vi.fn(() => ({})),
  onSnapshot: vi.fn((_ref: unknown, next: Next, error: ErrCb) => {
    calls.push({ next, error });
    return () => {};
  }),
}));

import { FirestoreRoomDirectory } from '../../src/services/FirestoreRoomDirectory';

describe('FirestoreRoomDirectory watchIdentities 重訂閱（A6）', () => {
  beforeEach(() => {
    calls.length = 0;
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('onSnapshot error → 退避後重訂閱；成功快照重置退避', () => {
    const dir = new FirestoreRoomDirectory('room-1', 'me');
    dir.watchIdentities(() => {});
    expect(calls).toHaveLength(1);

    // 第一次錯誤 → 1000ms 後重訂閱
    calls[0].error(new Error('transient'));
    vi.advanceTimersByTime(1000);
    expect(calls).toHaveLength(2);

    // 收到一次成功快照（重置退避），再錯一次仍以最短延遲重訂閱
    calls[1].next({ exists: () => false, data: () => ({}) });
    calls[1].error(new Error('transient again'));
    vi.advanceTimersByTime(1000);
    expect(calls).toHaveLength(3);
  });

  it('連續錯誤達 MAX_RETRIES 後停止重訂閱（永久錯誤收斂）', () => {
    const dir = new FirestoreRoomDirectory('room-1', 'me');
    dir.watchIdentities(() => {});

    // 退避序列 1s,2s,4s,8s,15s：連錯 5 次後應停止（不再有第 7 次訂閱）
    const delays = [1000, 2000, 4000, 8000, 15000];
    for (let i = 0; i < 6; i++) {
      const last = calls[calls.length - 1];
      last.error(new Error('permanent'));
      vi.advanceTimersByTime(delays[Math.min(i, delays.length - 1)]);
    }
    // 初次 + 5 次重訂閱 = 6，之後不再增加
    expect(calls.length).toBeLessThanOrEqual(6);
  });

  it('unsubscribe 後不再重訂閱', () => {
    const dir = new FirestoreRoomDirectory('room-1', 'me');
    const stop = dir.watchIdentities(() => {});
    stop();
    calls[0].error(new Error('after stop'));
    vi.advanceTimersByTime(15000);
    expect(calls).toHaveLength(1);
  });
});
