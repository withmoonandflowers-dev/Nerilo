/**
 * RoomHeartbeat 測試（房間活性心跳）
 *
 * - 啟動即跳一次 + 每 interval 跳一次
 * - stop 後不再跳
 * - 單次寫入失敗不中斷（下一輪照跳）
 *
 * @vitest-environment node
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { startRoomHeartbeat } from '../../src/services/RoomHeartbeat';

vi.mock('../../src/config/firebase', () => ({
  db: {},
  auth: {},
  functions: {},
  default: {},
}));

describe('startRoomHeartbeat', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('啟動立即跳一次，之後每 interval 跳一次', async () => {
    const writeFn = vi.fn().mockResolvedValue(undefined);
    const stop = startRoomHeartbeat('room-1', { intervalMs: 1000, writeFn });

    expect(writeFn).toHaveBeenCalledTimes(1); // 立即
    expect(writeFn).toHaveBeenCalledWith('room-1');

    await vi.advanceTimersByTimeAsync(3000);
    expect(writeFn).toHaveBeenCalledTimes(4); // 立即 + 3 輪

    stop();
  });

  it('stop 後不再跳', async () => {
    const writeFn = vi.fn().mockResolvedValue(undefined);
    const stop = startRoomHeartbeat('room-1', { intervalMs: 1000, writeFn });

    await vi.advanceTimersByTimeAsync(1000);
    expect(writeFn).toHaveBeenCalledTimes(2);

    stop();
    await vi.advanceTimersByTimeAsync(5000);
    expect(writeFn).toHaveBeenCalledTimes(2); // 不變
  });

  it('單次寫入失敗不中斷：下一輪照跳', async () => {
    const writeFn = vi
      .fn()
      .mockRejectedValueOnce(new Error('offline')) // 第一次失敗
      .mockResolvedValue(undefined);
    const stop = startRoomHeartbeat('room-1', { intervalMs: 1000, writeFn });

    await vi.advanceTimersByTimeAsync(2000);
    expect(writeFn).toHaveBeenCalledTimes(3); // 失敗不影響後續排程

    stop();
  });

  it('stop 恰在 interval 邊界呼叫也不多跳（stopped 旗標）', async () => {
    const writeFn = vi.fn().mockResolvedValue(undefined);
    const stop = startRoomHeartbeat('room-1', { intervalMs: 1000, writeFn });
    stop(); // 立刻停
    await vi.advanceTimersByTimeAsync(3000);
    expect(writeFn).toHaveBeenCalledTimes(1); // 只有啟動那一次
  });
});
