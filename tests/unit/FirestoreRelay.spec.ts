import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * FirestoreRelay unit tests with mocked Firestore.
 * Tests the relay logic without actual Firestore connection.
 */

// Mock Firestore before importing
vi.mock('../../src/config/firebase', () => ({
  db: {} as any,
}));

const mockAddDoc = vi.fn().mockResolvedValue({ id: 'relay-doc-1' });
const mockGetDocs = vi.fn().mockResolvedValue({ docs: [], empty: true });
const mockDeleteDoc = vi.fn().mockResolvedValue(undefined);
const mockOnSnapshot = vi.fn().mockReturnValue(() => {});

vi.mock('firebase/firestore', () => ({
  collection: vi.fn().mockReturnValue('mock-collection-ref'),
  addDoc: (...args: any[]) => mockAddDoc(...args),
  query: vi.fn().mockReturnValue('mock-query'),
  where: vi.fn().mockReturnValue('mock-where'),
  onSnapshot: (...args: any[]) => mockOnSnapshot(...args),
  serverTimestamp: vi.fn().mockReturnValue({ _type: 'serverTimestamp' }),
  Timestamp: {
    now: vi.fn().mockReturnValue({ toMillis: () => Date.now() }),
    fromMillis: vi.fn((ms: number) => ({ toMillis: () => ms })),
  },
  getDocs: (...args: any[]) => mockGetDocs(...args),
  deleteDoc: (...args: any[]) => mockDeleteDoc(...args),
}));

import { FirestoreRelay } from '../../src/core/transport/FirestoreRelay';

describe('FirestoreRelay', () => {
  let relay: FirestoreRelay;

  beforeEach(() => {
    vi.clearAllMocks();
    relay = new FirestoreRelay();
  });

  describe('send()', () => {
    it('should write a relay document to Firestore', async () => {
      await relay.send('room-1', 'user-b', 'user-a', '{"test":true}');

      expect(mockAddDoc).toHaveBeenCalledTimes(1);
      const docArg = mockAddDoc.mock.calls[0][1];
      expect(docArg.from).toBe('user-a');
      expect(docArg.to).toBe('user-b');
      expect(docArg.payload).toBe('{"test":true}');
    });

    it('should reject payloads exceeding 64KB', async () => {
      const bigPayload = 'x'.repeat(70_000);
      await expect(
        relay.send('room-1', 'user-b', 'user-a', bigPayload)
      ).rejects.toThrow('exceeds');
    });
  });

  describe('subscribe()', () => {
    it('should set up onSnapshot listener', () => {
      const handler = vi.fn();
      const unsub = relay.subscribe('room-1', 'user-a', handler);

      expect(mockOnSnapshot).toHaveBeenCalledTimes(1);
      expect(typeof unsub).toBe('function');
    });
  });

  describe('cleanup()', () => {
    it('should delete expired documents', async () => {
      const mockDocs = [
        { ref: 'doc-ref-1' },
        { ref: 'doc-ref-2' },
      ];
      mockGetDocs.mockResolvedValueOnce({
        docs: mockDocs,
        empty: false,
      });

      const count = await relay.cleanup('room-1');
      expect(count).toBe(2);
      expect(mockDeleteDoc).toHaveBeenCalledTimes(2);
    });

    it('should return 0 when no expired documents', async () => {
      mockGetDocs.mockResolvedValueOnce({ docs: [], empty: true });
      const count = await relay.cleanup('room-1');
      expect(count).toBe(0);
    });
  });

  describe('destroy()', () => {
    it('should unsubscribe all listeners', () => {
      const mockUnsub = vi.fn();
      mockOnSnapshot.mockReturnValue(mockUnsub);

      relay.subscribe('room-1', 'user-a', vi.fn());
      relay.subscribe('room-1', 'user-a', vi.fn());
      relay.destroy();

      expect(mockUnsub).toHaveBeenCalledTimes(2);
    });
  });
});
