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

vi.mock('firebase/firestore', () => ({
  collection: vi.fn(() => 'mock-collection'),
  doc: vi.fn((_db: unknown, _col: string, id: string) => ({ id, path: `p2pRooms/${id}` })),
  setDoc: (...args: unknown[]) => mockSetDoc(...args),
  getDoc: (...args: unknown[]) => mockGetDoc(...args),
  getDocFromServer: (...args: unknown[]) => mockGetDocFromServer(...args),
  getDocs: (...args: unknown[]) => mockGetDocs(...args),
  updateDoc: (...args: unknown[]) => mockUpdateDoc(...args),
  deleteDoc: (...args: unknown[]) => mockDeleteDoc(...args),
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
    it('sets status=migrating and increments hostMigrationEpoch', async () => {
      const { RoomService } = await import('../../src/services/RoomService');
      const room = makeRoom();
      mockGetDoc.mockResolvedValueOnce(makeFirestoreDoc(room));

      await RoomService.ownerLeaveRoom('room-1', 'owner-1');

      // First updateDoc call: set status=migrating and increment epoch
      expect(mockUpdateDoc).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          status: 'migrating',
          hostMigrationEpoch: 1,
        })
      );
    });

    it('sets status=closed when no remaining participants (does NOT delete document)', async () => {
      const { RoomService } = await import('../../src/services/RoomService');
      const room = makeRoom({ participants: ['owner-1'] }); // only owner
      mockGetDoc.mockResolvedValueOnce(makeFirestoreDoc(room));

      const result = await RoomService.ownerLeaveRoom('room-1', 'owner-1');

      expect(result.remainingParticipants).toHaveLength(0);
      expect(mockDeleteDoc).not.toHaveBeenCalled();

      // Should have called updateDoc with status=closed
      const allCalls = mockUpdateDoc.mock.calls;
      const closedCall = allCalls.find((call) =>
        call[1] && typeof call[1] === 'object' && (call[1] as any).status === 'closed'
      );
      expect(closedCall).toBeDefined();
    });

    it('closed room document is NOT deleted from Firestore', async () => {
      const { RoomService } = await import('../../src/services/RoomService');
      const room = makeRoom({ participants: ['owner-1'] });
      mockGetDoc.mockResolvedValueOnce(makeFirestoreDoc(room));

      await RoomService.ownerLeaveRoom('room-1', 'owner-1');

      expect(mockDeleteDoc).not.toHaveBeenCalled();
    });

    it('promotes new host from remaining participants when no promoteNewHostFn', async () => {
      const { RoomService } = await import('../../src/services/RoomService');
      const room = makeRoom();
      mockGetDoc.mockResolvedValueOnce(makeFirestoreDoc(room));

      const result = await RoomService.ownerLeaveRoom('room-1', 'owner-1');

      expect(result.remainingParticipants).toContain('member-2');
      expect(result.remainingParticipants).toContain('member-3');

      // Should update room with new ownerUid and status=open
      const openCall = mockUpdateDoc.mock.calls.find((call) =>
        call[1] && typeof call[1] === 'object' && (call[1] as any).status === 'open'
      );
      expect(openCall).toBeDefined();
      expect((openCall![1] as any).ownerUid).toBeDefined();
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

    it('hostMigrationEpoch increments on migration', async () => {
      const { RoomService } = await import('../../src/services/RoomService');
      const room = makeRoom({ hostMigrationEpoch: 5 });
      mockGetDoc.mockResolvedValueOnce(makeFirestoreDoc(room));

      await RoomService.ownerLeaveRoom('room-1', 'owner-1');

      const migratingCall = mockUpdateDoc.mock.calls.find((call) =>
        call[1] && typeof call[1] === 'object' && (call[1] as any).status === 'migrating'
      );
      expect((migratingCall![1] as any).hostMigrationEpoch).toBe(6);
    });

    it('uses promoteNewHostFn when provided and handles new room creation', async () => {
      const { RoomService } = await import('../../src/services/RoomService');
      const room = makeRoom();
      mockGetDoc.mockResolvedValueOnce(makeFirestoreDoc(room));

      const promoteNewHostFn = vi.fn().mockResolvedValue('new-room-id');

      const result = await RoomService.ownerLeaveRoom('room-1', 'owner-1', 'Owner', promoteNewHostFn);

      expect(promoteNewHostFn).toHaveBeenCalled();
      expect(result.remainingParticipants).toHaveLength(2);

      // Room should be closed (not have new owner set directly)
      const closedCall = mockUpdateDoc.mock.calls.find((call) =>
        call[1] && typeof call[1] === 'object' && (call[1] as any).status === 'closed'
      );
      expect(closedCall).toBeDefined();
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
    it('increments room version by 1', async () => {
      const { RoomService } = await import('../../src/services/RoomService');
      const room = makeRoom({ version: 3 });
      mockGetDoc.mockResolvedValueOnce(makeFirestoreDoc(room));

      await RoomService.incrementVersion('room-1');

      expect(mockUpdateDoc).toHaveBeenCalledWith(
        expect.anything(),
        { version: 4 }
      );
    });

    it('starts from 0 if no version set', async () => {
      const { RoomService } = await import('../../src/services/RoomService');
      const room = makeRoom();
      delete (room as Partial<P2PRoom>).version;
      mockGetDoc.mockResolvedValueOnce(makeFirestoreDoc(room));

      await RoomService.incrementVersion('room-1');

      expect(mockUpdateDoc).toHaveBeenCalledWith(
        expect.anything(),
        { version: 1 }
      );
    });
  });
});
