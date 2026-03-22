/**
 * 測試 RoomService 純邏輯（無需 Firebase 連線）
 * - isRoomTimeout：waiting 房間超時計算
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { RoomService } from '../../src/services/RoomService';
import type { P2PRoom } from '../../src/types';

// 避免 firebase 初始化
vi.mock('../../src/config/firebase', () => ({
  db: {},
  auth: {},
  functions: {},
  default: {},
}));

function makeWaitingRoom(overrides: Partial<P2PRoom> = {}): P2PRoom {
  return {
    roomId: 'room-1',
    ownerUid: 'owner-1',
    ownerName: 'Owner',
    participants: ['owner-1'],
    status: 'waiting',
    isPrivate: false,
    createdAt: Date.now(),
    waitingTimeout: 5 * 60 * 1000, // 5 分鐘
    waitingStartedAt: Date.now(),
    ...overrides,
  };
}

describe('RoomService.isRoomTimeout', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('非 waiting 狀態的房間永遠不超時', () => {
    const open = makeWaitingRoom({ status: 'open' });
    const closed = makeWaitingRoom({ status: 'closed' });
    expect(RoomService.isRoomTimeout(open)).toBe(false);
    expect(RoomService.isRoomTimeout(closed)).toBe(false);
  });

  it('缺少 waitingStartedAt 時回傳 false', () => {
    const room = makeWaitingRoom({ waitingStartedAt: undefined });
    expect(RoomService.isRoomTimeout(room)).toBe(false);
  });

  it('缺少 waitingTimeout 時回傳 false', () => {
    const room = makeWaitingRoom({ waitingTimeout: undefined });
    expect(RoomService.isRoomTimeout(room)).toBe(false);
  });

  it('尚未超時時回傳 false', () => {
    const now = Date.now();
    const room = makeWaitingRoom({
      waitingStartedAt: now,
      waitingTimeout: 5 * 60 * 1000, // 5 分鐘
    });
    // 經過 4 分 59 秒 — 還未到期
    vi.setSystemTime(now + 4 * 60 * 1000 + 59 * 1000);
    expect(RoomService.isRoomTimeout(room)).toBe(false);
  });

  it('剛好達到 waitingTimeout 時回傳 true', () => {
    const now = Date.now();
    const timeout = 5 * 60 * 1000;
    const room = makeWaitingRoom({
      waitingStartedAt: now,
      waitingTimeout: timeout,
    });
    vi.setSystemTime(now + timeout);
    expect(RoomService.isRoomTimeout(room)).toBe(true);
  });

  it('超過 waitingTimeout 時回傳 true', () => {
    const now = Date.now();
    const room = makeWaitingRoom({
      waitingStartedAt: now,
      waitingTimeout: 5 * 60 * 1000,
    });
    // 已超過 10 分鐘
    vi.setSystemTime(now + 10 * 60 * 1000);
    expect(RoomService.isRoomTimeout(room)).toBe(true);
  });

  it('極短 timeout（1ms）也能正確超時', () => {
    const now = Date.now();
    const room = makeWaitingRoom({
      waitingStartedAt: now,
      waitingTimeout: 1,
    });
    vi.setSystemTime(now + 2);
    expect(RoomService.isRoomTimeout(room)).toBe(true);
  });
});
