import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { P2PRoom } from '../../src/types';

// Mock firebase modules
vi.mock('../../src/config/firebase', () => ({
  db: {},
  auth: {},
  functions: {},
  default: {},
}));

// Track updateDoc and deleteDoc calls
const mockUpdateDoc = vi.fn().mockResolvedValue(undefined);
const mockDeleteDoc = vi.fn().mockResolvedValue(undefined);
const mockGetDoc = vi.fn();
const mockGetDocFromServer = vi.fn();
const mockGetDocs = vi.fn().mockResolvedValue({ docs: [] });
const mockSetDoc = vi.fn().mockResolvedValue(undefined);

/**
 * Mock runTransaction：
 * 呼叫 callback 時傳入一個假 transaction 物件，記錄 .get / .update 呼叫
 */
const mockTransactionGet = vi.fn();
const mockTransactionUpdate = vi.fn();
const mockRunTransaction = vi.fn(async (_db: unknown, cb: (t: unknown) => Promise<unknown>) => {
  const transaction = {
    get: mockTransactionGet,
    update: mockTransactionUpdate,
  };
  return cb(transaction);
});

/** Mock increment()：回傳一個帶有 __increment 標記的哨兵物件，方便斷言 */
const mockIncrement = vi.fn((n: number) => ({ __type: 'FieldValue.increment', operand: n }));

vi.mock('firebase/firestore', () => ({
  collection: vi.fn(() => 'mock-collection'),
  doc: vi.fn((_db: unknown, _col: string, id: string) => ({ id, path: `p2pRooms/${id}` })),
  setDoc: (...args: unknown[]) => mockSetDoc(...args),
  getDoc: (...args: unknown[]) => mockGetDoc(...args),
  getDocFromServer: (...args: unknown[]) => mockGetDocFromServer(...args),
  getDocs: (...args: unknown[]) => mockGetDocs(...args),
  updateDoc: (...args: unknown[]) => mockUpdateDoc(...args),
  deleteDoc: (...args: unknown[]) => mockDeleteDoc(...args),
  runTransaction: (...args: unknown[]) => mockRunTransaction(...args),
  increment: (n: number) => mockIncrement(n),
  onSnapshot: vi.fn(() => vi.fn()),
  query: vi.fn((...args: unknown[]) => args),
  where: vi.fn((...args: unknown[]) => args),
  Timestamp: {
    fromMillis: (ms: number) => ({ toMillis: () => ms, seconds: ms / 1000, nanoseconds: 0 }),
    now: () => ({ toMillis: () => Date.now() }),
  },
  arrayUnion: vi.fn((...args: unknown[]) => args),
  arrayRemove: vi.fn((...args: unknown[]) => args),
}));

vi.mock('../../src/utils/uuid', () => ({
  generateUUID: vi.fn(() => 'generated-uuid'),
}));

function makeRoom(overrides: Partial<P2PRoom> = {}): P2PRoom {
  return {
    roomId: 'room-1',
    ownerUid: 'owner-1',
    ownerName: 'Owner',
    participants: ['owner-1', 'member-2', 'member-3'],
    status: 'open',
    isPrivate: false,
    createdAt: Date.now(),
    hostMigrationEpoch: 0,
    ...overrides,
  };
}

function makeFirestoreDoc(room: P2PRoom) {
  return {
    exists: () => true,
    id: room.roomId,
    data: () => ({
      ...room,
      createdAt: { toMillis: () => room.createdAt },
      waitingStartedAt: room.waitingStartedAt ? { toMillis: () => room.waitingStartedAt } : undefined,
      hostMigrationEpoch: room.hostMigrationEpoch ?? 0,
      version: room.version ?? 0,
    }),
  };
}

describe('RoomService - Host Migration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('ownerLeaveRoom', () => {
    it('uses transaction and sets status=open with new owner when remaining participants', async () => {
      const { RoomService } = await import('../../src/services/RoomService');
      const room = makeRoom();
      // getRoom() 內部用 getDoc
      mockGetDoc.mockResolvedValueOnce(makeFirestoreDoc(room));
      // transaction.get() 回傳
      mockTransactionGet.mockResolvedValueOnce(makeFirestoreDoc(room));

      const result = await RoomService.ownerLeaveRoom('room-1', 'owner-1');

      // 應使用 runTransaction
      expect(mockRunTransaction).toHaveBeenCalled();
      // transaction.update 應被呼叫，設定 status='open' 和新 ownerUid
      expect(mockTransactionUpdate).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          status: 'open',
          ownerUid: 'member-2',
          hostMigrationEpoch: 1,
        })
      );
      expect(result.remainingParticipants).toContain('member-2');
      expect(result.remainingParticipants).toContain('member-3');
      expect(result.newOwnerUid).toBe('member-2');
    });

    it('sets status=closed when no remaining participants (does NOT delete document)', async () => {
      const { RoomService } = await import('../../src/services/RoomService');
      const room = makeRoom({ participants: ['owner-1'] });
      mockGetDoc.mockResolvedValueOnce(makeFirestoreDoc(room));
      mockTransactionGet.mockResolvedValueOnce(makeFirestoreDoc(room));

      const result = await RoomService.ownerLeaveRoom('room-1', 'owner-1');

      expect(result.remainingParticipants).toHaveLength(0);
      expect(mockDeleteDoc).not.toHaveBeenCalled();
      // transaction.update 應包含 status='closed'
      expect(mockTransactionUpdate).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ status: 'closed' })
      );
    });

    it('closed room document is NOT deleted from Firestore', async () => {
      const { RoomService } = await import('../../src/services/RoomService');
      const room = makeRoom({ participants: ['owner-1'] });
      mockGetDoc.mockResolvedValueOnce(makeFirestoreDoc(room));
      mockTransactionGet.mockResolvedValueOnce(makeFirestoreDoc(room));

      await RoomService.ownerLeaveRoom('room-1', 'owner-1');

      expect(mockDeleteDoc).not.toHaveBeenCalled();
    });

    it('promotes new host from remaining participants when no promoteNewHostFn', async () => {
      const { RoomService } = await import('../../src/services/RoomService');
      const room = makeRoom();
      mockGetDoc.mockResolvedValueOnce(makeFirestoreDoc(room));
      mockTransactionGet.mockResolvedValueOnce(makeFirestoreDoc(room));

      const result = await RoomService.ownerLeaveRoom('room-1', 'owner-1');

      expect(result.remainingParticipants).toContain('member-2');
      expect(result.remainingParticipants).toContain('member-3');
      expect(result.newOwnerUid).toBeDefined();
    });

    it('throws when non-owner calls ownerLeaveRoom', async () => {
      const { RoomService } = await import('../../src/services/RoomService');
      const room = makeRoom();
      mockGetDoc.mockResolvedValueOnce(makeFirestoreDoc(room));

      await expect(
        RoomService.ownerLeaveRoom('room-1', 'not-the-owner')
      ).rejects.toThrow();
    });

    it('returns empty when room does not exist', async () => {
      const { RoomService } = await import('../../src/services/RoomService');
      mockGetDoc.mockResolvedValueOnce({
        exists: () => false,
        id: 'room-1',
        data: () => ({}),
      });

      const result = await RoomService.ownerLeaveRoom('room-1', 'owner-1');
      expect(result.remainingParticipants).toHaveLength(0);
    });

    it('hostMigrationEpoch increments atomically in transaction', async () => {
      const { RoomService } = await import('../../src/services/RoomService');
      const room = makeRoom({ hostMigrationEpoch: 5 });
      mockGetDoc.mockResolvedValueOnce(makeFirestoreDoc(room));
      mockTransactionGet.mockResolvedValueOnce(makeFirestoreDoc(room));

      await RoomService.ownerLeaveRoom('room-1', 'owner-1');

      expect(mockTransactionUpdate).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ hostMigrationEpoch: 6 })
      );
    });

    it('uses promoteNewHostFn when provided and handles new room creation', async () => {
      const { RoomService } = await import('../../src/services/RoomService');
      const room = makeRoom();
      mockGetDoc.mockResolvedValueOnce(makeFirestoreDoc(room));
      mockTransactionGet.mockResolvedValueOnce(makeFirestoreDoc(room));

      const promoteNewHostFn = vi.fn().mockResolvedValue('new-room-id');

      const result = await RoomService.ownerLeaveRoom('room-1', 'owner-1', 'Owner', promoteNewHostFn);

      expect(promoteNewHostFn).toHaveBeenCalled();
      expect(result.remainingParticipants).toHaveLength(2);

      // 在 transaction 之後，room 應被 closed（via updateDoc，非 transaction）
      expect(mockUpdateDoc).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ status: 'closed' })
      );
    });
  });

  describe('updateRoomStatus', () => {
    it('writes the correct status to Firestore', async () => {
      const { RoomService } = await import('../../src/services/RoomService');
      await RoomService.updateRoomStatus('room-1', 'closing');
      expect(mockUpdateDoc).toHaveBeenCalledWith(
        expect.anything(),
        { status: 'closing' }
      );
    });
  });

  describe('incrementVersion', () => {
    it('uses atomic increment(1) instead of read-then-write', async () => {
      const { RoomService } = await import('../../src/services/RoomService');

      await RoomService.incrementVersion('room-1');

      expect(mockUpdateDoc).toHaveBeenCalledWith(
        expect.anything(),
        { version: expect.objectContaining({ __type: 'FieldValue.increment', operand: 1 }) }
      );
    });

    it('does not require reading the room first', async () => {
      const { RoomService } = await import('../../src/services/RoomService');

      await RoomService.incrementVersion('room-1');

      // 原子操作不需要先 getDoc
      expect(mockGetDoc).not.toHaveBeenCalled();
    });
  });
});
