import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * FirestoreRelay unit tests with mocked Firebase Realtime Database.
 * Tests the relay logic without actual RTDB connection.
 */

// Mock RTDB config
vi.mock('../../src/config/firebase', () => ({
  rtdb: {} as any,
}));

vi.mock('../../src/config/rtdb-paths', () => ({
  RTDB: {
    relay: (roomId: string) => `relay/${roomId}`,
  },
}));

const mockPushRef = { key: 'relay-push-1' };
const mockPush = vi.fn().mockReturnValue(mockPushRef);
const mockSet = vi.fn().mockResolvedValue(undefined);
const mockGet = vi.fn().mockResolvedValue({ exists: () => false, forEach: () => {} });
const mockRemove = vi.fn().mockResolvedValue(undefined);
const mockOnChildAdded = vi.fn().mockReturnValue(() => {});
const mockRef = vi.fn().mockReturnValue('mock-ref');
const mockRtdbQuery = vi.fn().mockReturnValue('mock-query');
const mockOrderByChild = vi.fn().mockReturnValue('mock-order');
const mockEqualTo = vi.fn().mockReturnValue('mock-equal');

vi.mock('firebase/database', () => ({
  ref: (...args: any[]) => mockRef(...args),
  push: (...args: any[]) => mockPush(...args),
  set: (...args: any[]) => mockSet(...args),
  get: (...args: any[]) => mockGet(...args),
  remove: (...args: any[]) => mockRemove(...args),
  onChildAdded: (...args: any[]) => mockOnChildAdded(...args),
  query: (...args: any[]) => mockRtdbQuery(...args),
  orderByChild: (...args: any[]) => mockOrderByChild(...args),
  equalTo: (...args: any[]) => mockEqualTo(...args),
  onDisconnect: vi.fn(),
}));

import { FirestoreRelay } from '../../src/core/transport/FirestoreRelay';

describe('FirestoreRelay', () => {
  let relay: FirestoreRelay;

  beforeEach(() => {
    vi.clearAllMocks();
    relay = new FirestoreRelay();
  });

  describe('send()', () => {
    it('should write a relay message via push+set to RTDB', async () => {
      await relay.send('room-1', 'user-b', 'user-a', '{"test":true}');

      expect(mockRef).toHaveBeenCalled();
      expect(mockPush).toHaveBeenCalledTimes(1);
      expect(mockSet).toHaveBeenCalledTimes(1);
      const msgArg = mockSet.mock.calls[0][1];
      expect(msgArg.from).toBe('user-a');
      expect(msgArg.to).toBe('user-b');
      expect(msgArg.payload).toBe('{"test":true}');
    });

    it('should reject payloads exceeding 64KB', async () => {
      const bigPayload = 'x'.repeat(70_000);
      await expect(
        relay.send('room-1', 'user-b', 'user-a', bigPayload)
      ).rejects.toThrow('exceeds');
    });
  });

  describe('subscribe()', () => {
    it('should set up onChildAdded listener', () => {
      const handler = vi.fn();
      const unsub = relay.subscribe('room-1', 'user-a', handler);

      expect(mockOnChildAdded).toHaveBeenCalledTimes(1);
      expect(typeof unsub).toBe('function');
    });

    it('should invoke handler when a matching child is added', () => {
      const handler = vi.fn();

      // Capture the onChildAdded callback
      mockOnChildAdded.mockImplementation((_query: any, cb: any) => {
        // Simulate an incoming message
        const snapshot = {
          val: () => ({
            from: 'user-b',
            to: 'user-a',
            payload: '{"hello":true}',
            createdAt: Date.now(),
            expiresAt: Date.now() + 30_000,
          }),
          ref: 'mock-child-ref',
        };
        cb(snapshot);
        return () => {};
      });

      relay.subscribe('room-1', 'user-a', handler);

      expect(handler).toHaveBeenCalledWith('user-b', '{"hello":true}');
    });
  });

  describe('cleanup()', () => {
    it('should delete expired entries', async () => {
      const now = Date.now();
      const expiredChildren = [
        {
          val: () => ({ expiresAt: now - 10_000 }),
          ref: 'child-ref-1',
        },
        {
          val: () => ({ expiresAt: now - 5_000 }),
          ref: 'child-ref-2',
        },
      ];

      mockGet.mockResolvedValueOnce({
        exists: () => true,
        forEach: (cb: (child: any) => void) => {
          expiredChildren.forEach(cb);
        },
      });

      const count = await relay.cleanup('room-1');
      expect(count).toBe(2);
      expect(mockRemove).toHaveBeenCalledTimes(2);
    });

    it('should return 0 when no entries exist', async () => {
      mockGet.mockResolvedValueOnce({
        exists: () => false,
        forEach: () => {},
      });
      const count = await relay.cleanup('room-1');
      expect(count).toBe(0);
    });
  });

  describe('destroy()', () => {
    it('should unsubscribe all listeners', () => {
      const mockUnsub = vi.fn();
      mockOnChildAdded.mockReturnValue(mockUnsub);

      relay.subscribe('room-1', 'user-a', vi.fn());
      relay.subscribe('room-1', 'user-a', vi.fn());
      relay.destroy();

      expect(mockUnsub).toHaveBeenCalledTimes(2);
    });
  });
});
