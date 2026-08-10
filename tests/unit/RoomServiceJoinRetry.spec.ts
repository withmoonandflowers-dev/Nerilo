/**
 * joinRoom / leaveRoom 對「併發改名冊」的重試行為。
 *
 * 為什麼要有這支：rules 是拿已提交的文件評估，而且評在 updateTime 前置條件之前。
 * 別人在我們讀取後入房，我們送出的名冊就少了他，isSelfJoinOnly() 的「不得移除既有
 * 成員」先擋下來，回傳 permission-denied 而不是 aborted，Firebase SDK 因此不會
 * 自己重試。CI 的 mesh-e2ee 三人同時入房連三天紅在這裡（2026-08-07 至 08-09）。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../src/config/firebase', () => ({ db: {}, auth: {}, functions: {}, default: {} }));

const mockTransactionGet = vi.fn();
const mockTransactionUpdate = vi.fn();
let attempts = 0;
let failWith: string[] = [];

const mockRunTransaction = vi.fn(async (_db: unknown, cb: (t: unknown) => Promise<unknown>) => {
  const code = failWith[attempts];
  attempts += 1;
  if (code) throw Object.assign(new Error(code), { code });
  return cb({ get: mockTransactionGet, update: mockTransactionUpdate });
});

vi.mock('firebase/firestore', () => ({
  collection: vi.fn(() => 'mock-collection'),
  doc: vi.fn((_db: unknown, _col: string, id: string) => ({ id, path: `p2pRooms/${id}` })),
  setDoc: vi.fn(), getDoc: vi.fn(), getDocFromServer: vi.fn(),
  getDocs: vi.fn().mockResolvedValue({ docs: [] }),
  updateDoc: vi.fn(), deleteDoc: vi.fn(),
  runTransaction: (...args: unknown[]) => mockRunTransaction(...(args as [unknown, never])),
  increment: (n: number) => ({ __increment: n }),
  onSnapshot: vi.fn(() => vi.fn()),
  query: vi.fn((...a: unknown[]) => a), where: vi.fn((...a: unknown[]) => a),
  limit: vi.fn((n: number) => n),
  Timestamp: { fromMillis: (ms: number) => ({ toMillis: () => ms }), now: () => ({ toMillis: () => Date.now() }) },
  arrayUnion: vi.fn((...a: unknown[]) => a), arrayRemove: vi.fn((...a: unknown[]) => a),
}));

vi.mock('../../src/utils/uuid', () => ({ generateUUID: vi.fn(() => 'generated-uuid') }));

const { RoomService } = await import('../../src/services/RoomService');

function roomSnap(participants: string[]) {
  return {
    exists: () => true,
    data: () => ({
      ownerUid: 'owner-1', participants, participantCount: participants.length,
      status: 'open', maxParticipants: 10,
    }),
  };
}

beforeEach(() => {
  attempts = 0;
  failWith = [];
  vi.clearAllMocks();
  mockTransactionGet.mockResolvedValue(roomSnap(['owner-1']));
});

describe('joinRoom 對併發名冊變動的重試', () => {
  it('第一次 permission-denied 後重讀並成功', async () => {
    failWith = ['permission-denied'];
    await expect(RoomService.joinRoom('room-1', 'joiner-9')).resolves.toBeUndefined();
    expect(mockRunTransaction).toHaveBeenCalledTimes(2);
  });

  it('連續 aborted / permission-denied 混合仍會走完重試', async () => {
    failWith = ['aborted', 'permission-denied', 'failed-precondition'];
    await expect(RoomService.joinRoom('room-1', 'joiner-9')).resolves.toBeUndefined();
    expect(mockRunTransaction).toHaveBeenCalledTimes(4);
  });

  it('真的無權時重試耗盡仍往外拋，不會被吞掉', async () => {
    failWith = Array(6).fill('permission-denied');
    await expect(RoomService.joinRoom('room-1', 'joiner-9')).rejects.toMatchObject({
      code: 'permission-denied',
    });
    expect(mockRunTransaction).toHaveBeenCalledTimes(4);
  });

  it('不可重試的錯誤立即拋出，不浪費重試次數', async () => {
    failWith = ['room-full'];
    await expect(RoomService.joinRoom('room-1', 'joiner-9')).rejects.toMatchObject({
      code: 'room-full',
    });
    expect(mockRunTransaction).toHaveBeenCalledTimes(1);
  });
});

describe('leaveRoom 同樣要能撐過併發名冊變動', () => {
  beforeEach(() => {
    mockTransactionGet.mockResolvedValue(roomSnap(['owner-1', 'leaver-2']));
  });

  it('permission-denied 後重讀並成功', async () => {
    failWith = ['permission-denied'];
    await expect(RoomService.leaveRoom('room-1', 'leaver-2')).resolves.toBeUndefined();
    expect(mockRunTransaction).toHaveBeenCalledTimes(2);
  });

  // leaveRoom 是 best-effort：離房失敗不可以擋住導航。2026-08-10 重構時一度把它
  // 換成共用重試 helper 而讓錯誤外漏，這兩條就是為了不再犯。
  it('重試耗盡也不往外拋（吞掉以免擋住導航）', async () => {
    failWith = Array(6).fill('permission-denied');
    await expect(RoomService.leaveRoom('room-1', 'leaver-2')).resolves.toBeUndefined();
    expect(mockRunTransaction).toHaveBeenCalledTimes(4);
  });

  it('不可重試的錯誤也不往外拋', async () => {
    failWith = ['unavailable'];
    await expect(RoomService.leaveRoom('room-1', 'leaver-2')).resolves.toBeUndefined();
    expect(mockRunTransaction).toHaveBeenCalledTimes(1);
  });
});
