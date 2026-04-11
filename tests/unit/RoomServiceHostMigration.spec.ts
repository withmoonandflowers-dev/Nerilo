import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { P2PRoom } from '../../src/types';

// Mock firebase config — export rtdb for RTDB-based code
vi.mock('../../src/config/firebase', () => ({
  rtdb: {},
  auth: {},
  functions: {},
  default: {},
}));

// Mock RTDB paths
vi.mock('../../src/config/rtdb-paths', () => ({
  RTDB: {
    room: (id: string) => `rooms/${id}`,
    rooms: () => 'rooms',
    signals: (id: string) => `signals/${id}`,
    relay: (id: string) => `relay/${id}`,
    roomParticipant: (roomId: string, uid: string) => `rooms/${roomId}/participants/${uid}`,
  },
}));

// RTDB mocks
const mockRtdbUpdate = vi.fn().mockResolvedValue(undefined);
const mockRtdbRemove = vi.fn().mockResolvedValue(undefined);
const mockRtdbGet = vi.fn();
const mockRtdbSet = vi.fn().mockResolvedValue(undefined);
const mockRtdbRef = vi.fn((_db: unknown, _path?: string) => ({ path: _path || 'mock-ref' }));
const mockRtdbOnValue = vi.fn(() => vi.fn());

const mockRtdbRunTransaction = vi.fn(async (_ref: unknown, updateFn: (current: any) => any) => {
  const currentData = (mockRtdbRunTransaction as any)._currentData ?? null;
  const newData = updateFn(currentData);
  return { committed: true, snapshot: { val: () => newData } };
}) as any;
mockRtdbRunTransaction._currentData = null;

const mockOnDisconnect = vi.fn(() => ({
  remove: vi.fn().mockReturnValue(Promise.resolve()),
  set: vi.fn().mockReturnValue(Promise.resolve()),
}));

vi.mock('firebase/database', () => ({
  ref: (...args: unknown[]) => mockRtdbRef(...args),
  set: (...args: unknown[]) => mockRtdbSet(...args),
  get: (...args: unknown[]) => mockRtdbGet(...args),
  update: (...args: unknown[]) => mockRtdbUpdate(...args),
  remove: (...args: unknown[]) => mockRtdbRemove(...args),
  onValue: (...args: unknown[]) => mockRtdbOnValue(...args),
  runTransaction: (...args: unknown[]) => mockRtdbRunTransaction(...args),
  query: vi.fn((...args: unknown[]) => args),
  orderByChild: vi.fn((...args: unknown[]) => args),
  equalTo: vi.fn((...args: unknown[]) => args),
  onDisconnect: (...args: unknown[]) => mockOnDisconnect(...args),
  DataSnapshot: {},
}));

vi.mock('../../src/utils/uuid', () => ({
  generateUUID: vi.fn(() => 'generated-uuid'),
}));

/**
 * Build an RTDB snapshot mock for a room that exists.
 * RTDB stores participants as { uid: true } objects.
 */
function makeRtdbSnapshot(room: P2PRoom) {
  return {
    exists: () => true,
    val: () => ({
      ownerUid: room.ownerUid,
      ownerName: room.ownerName,
      participants: Object.fromEntries(room.participants.map((p) => [p, true])),
      status: room.status,
      isPrivate: room.isPrivate,
      createdAt: room.createdAt,
      waitingTimeout: room.waitingTimeout ?? 5 * 60 * 1000,
      waitingStartedAt: room.waitingStartedAt,
      hostMigrationEpoch: room.hostMigrationEpoch ?? 0,
      version: (room as any).version ?? 0,
    }),
  };
}

/** Build a snapshot for a room that does not exist */
function makeEmptySnapshot() {
  return {
    exists: () => false,
    val: () => null,
  };
}

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

describe('RoomService - Host Migration', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    mockRtdbRunTransaction._currentData = null;
  });

  describe('ownerLeaveRoom', () => {
    it('deletes the room node via remove() and returns remaining participants', async () => {
      const { RoomService } = await import('../../src/services/RoomService');
      const room = makeRoom();
      // getRoom() calls get(ref(rtdb, RTDB.room(roomId)))
      mockRtdbGet.mockResolvedValueOnce(makeRtdbSnapshot(room));

      const result = await RoomService.ownerLeaveRoom('room-1', 'owner-1');

      // Room should be removed via remove()
      expect(mockRtdbRemove).toHaveBeenCalled();
      // Remaining participants should exclude the owner
      expect(result.remainingParticipants).toContain('member-2');
      expect(result.remainingParticipants).toContain('member-3');
      expect(result.remainingParticipants).not.toContain('owner-1');
    });

    it('returns empty participants when owner is the only participant', async () => {
      const { RoomService } = await import('../../src/services/RoomService');
      const room = makeRoom({ participants: ['owner-1'] });
      mockRtdbGet.mockResolvedValueOnce(makeRtdbSnapshot(room));

      const result = await RoomService.ownerLeaveRoom('room-1', 'owner-1');

      expect(result.remainingParticipants).toHaveLength(0);
      // Room is still removed
      expect(mockRtdbRemove).toHaveBeenCalled();
    });

    it('throws when non-owner calls ownerLeaveRoom', async () => {
      const { RoomService } = await import('../../src/services/RoomService');
      const room = makeRoom();
      mockRtdbGet.mockResolvedValueOnce(makeRtdbSnapshot(room));

      await expect(
        RoomService.ownerLeaveRoom('room-1', 'not-the-owner')
      ).rejects.toThrow();
    });

    it('returns empty when room does not exist', async () => {
      const { RoomService } = await import('../../src/services/RoomService');
      mockRtdbGet.mockResolvedValueOnce(makeEmptySnapshot());

      const result = await RoomService.ownerLeaveRoom('room-1', 'owner-1');
      expect(result.remainingParticipants).toHaveLength(0);
    });

    it('room node is removed from RTDB on owner leave', async () => {
      const { RoomService } = await import('../../src/services/RoomService');
      const room = makeRoom({ participants: ['owner-1'] });
      mockRtdbGet.mockResolvedValueOnce(makeRtdbSnapshot(room));

      await RoomService.ownerLeaveRoom('room-1', 'owner-1');

      expect(mockRtdbRemove).toHaveBeenCalled();
    });
  });

  describe('closeRoom', () => {
    it('writes status=closed via RTDB update()', async () => {
      const { RoomService } = await import('../../src/services/RoomService');
      const room = makeRoom();
      // closeRoom calls getRoom() internally which calls get()
      mockRtdbGet.mockResolvedValueOnce(makeRtdbSnapshot(room));

      await RoomService.closeRoom('room-1', 'owner-1');

      expect(mockRtdbUpdate).toHaveBeenCalledWith(
        expect.anything(),
        { status: 'closed' }
      );
    });
  });

  describe('deleteRoom', () => {
    it('removes the room node when called by the owner', async () => {
      const { RoomService } = await import('../../src/services/RoomService');
      const room = makeRoom();
      mockRtdbGet.mockResolvedValueOnce(makeRtdbSnapshot(room));

      await RoomService.deleteRoom('room-1', 'owner-1');

      expect(mockRtdbRemove).toHaveBeenCalled();
    });

    it('throws when non-owner tries to delete', async () => {
      const { RoomService } = await import('../../src/services/RoomService');
      const room = makeRoom();
      mockRtdbGet.mockResolvedValueOnce(makeRtdbSnapshot(room));

      await expect(
        RoomService.deleteRoom('room-1', 'not-the-owner')
      ).rejects.toThrow();
    });
  });
});
