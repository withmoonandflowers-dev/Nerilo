/**
 * B1：房間分頁互斥鎖。同一房只讓一個分頁參與 mesh，其餘誠實告知。
 *
 * @vitest-environment node
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { acquireRoomTabLock, roomTabLockName } from '../../src/utils/roomTabLock';

type LockCb = (lock: unknown) => Promise<void>;

/** Node 的 globalThis.navigator 是唯讀 getter，只能用 defineProperty 覆寫。 */
function setNavigator(value: unknown): void {
  Object.defineProperty(globalThis, 'navigator', { value, configurable: true, writable: true });
}

/** 假的 Web Locks：以名稱記錄「目前是否被持有」 */
function installFakeLocks() {
  const held = new Set<string>();
  const request = vi.fn(async (name: string, opts: { ifAvailable?: boolean }, cb: LockCb) => {
    if (held.has(name)) {
      if (opts.ifAvailable) return cb(null); // 已被持有 → 立即回 null，不等待
      return;
    }
    held.add(name);
    try {
      await cb({ name });
    } finally {
      held.delete(name);
    }
  });
  setNavigator({ locks: { request } });
  return { held, request };
}

afterEach(() => {
  // 還原成「有 navigator 但無 locks」＝ Node 預設，等同舊瀏覽器情境
  setNavigator({});
});

const flush = () => new Promise((r) => setTimeout(r, 0));

describe('acquireRoomTabLock（B1）', () => {
  it('第一個分頁取得鎖', async () => {
    installFakeLocks();
    const onAcquired = vi.fn();
    const onBusy = vi.fn();
    acquireRoomTabLock('room-1', { onAcquired, onBusy });
    await flush();
    expect(onAcquired).toHaveBeenCalledTimes(1);
    expect(onBusy).not.toHaveBeenCalled();
  });

  it('第二個分頁拿不到 → onBusy（不等待）', async () => {
    installFakeLocks();
    acquireRoomTabLock('room-1', { onAcquired: vi.fn(), onBusy: vi.fn() });
    await flush();

    const onAcquired = vi.fn();
    const onBusy = vi.fn();
    acquireRoomTabLock('room-1', { onAcquired, onBusy });
    await flush();
    expect(onBusy).toHaveBeenCalledTimes(1);
    expect(onAcquired).not.toHaveBeenCalled();
  });

  it('第一個分頁釋放後，第二個分頁可取得', async () => {
    installFakeLocks();
    const first = acquireRoomTabLock('room-1', { onAcquired: vi.fn(), onBusy: vi.fn() });
    await flush();
    first.release();
    await flush();

    const onAcquired = vi.fn();
    acquireRoomTabLock('room-1', { onAcquired, onBusy: vi.fn() });
    await flush();
    expect(onAcquired).toHaveBeenCalledTimes(1);
  });

  it('不同房間互不影響', async () => {
    installFakeLocks();
    acquireRoomTabLock('room-1', { onAcquired: vi.fn(), onBusy: vi.fn() });
    await flush();
    const onAcquired = vi.fn();
    const onBusy = vi.fn();
    acquireRoomTabLock('room-2', { onAcquired, onBusy });
    await flush();
    expect(onAcquired).toHaveBeenCalledTimes(1);
    expect(onBusy).not.toHaveBeenCalled();
  });

  it('Web Locks 不可用（舊瀏覽器/測試環境）→ 視同取得，不擋住聊天', async () => {
    setNavigator({}); // 有 navigator 但無 locks
    const onAcquired = vi.fn();
    const onBusy = vi.fn();
    acquireRoomTabLock('room-1', { onAcquired, onBusy });
    expect(onAcquired).toHaveBeenCalledTimes(1);
    expect(onBusy).not.toHaveBeenCalled();
  });

  it('取鎖失敗（request 擲錯）→ 退回既有行為，不擋住聊天', async () => {
    setNavigator({ locks: { request: vi.fn().mockRejectedValue(new Error('denied')) } });
    const onAcquired = vi.fn();
    acquireRoomTabLock('room-1', { onAcquired, onBusy: vi.fn() });
    await flush();
    expect(onAcquired).toHaveBeenCalledTimes(1);
  });

  it('鎖名以房間隔離', () => {
    expect(roomTabLockName('abc')).toBe('nerilo.room.abc');
    expect(roomTabLockName('abc')).not.toBe(roomTabLockName('abd'));
  });
});
