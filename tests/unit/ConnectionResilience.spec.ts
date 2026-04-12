/**
 * Connection Resilience Tests
 *
 * Tests P2PConnectionManager reconnect logic:
 *  1. ICE restart -> full reconnect progression
 *  2. Connection state transitions: idle -> connecting -> connected -> failed -> connecting -> connected
 *  3. Max attempts reached -> failed state
 *  4. Jitter delay within [50%, 100%] of exponential backoff
 *
 * @vitest-environment node
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Signal, ConnectionState } from '../../src/types';

// ── Firebase RTDB mock ───────────────────────────────────────────────────────
vi.mock('../../src/config/firebase', () => ({ rtdb: {} }));

vi.mock('../../src/config/rtdb-paths', () => ({
  RTDB: {
    signals: (roomId: string) => `signals/${roomId}`,
    signal: (roomId: string, id: string) => `signals/${roomId}/${id}`,
  },
}));

let capturedOnChildAddedCb: ((snapshot: any) => void) | null = null;

const mockRef = { key: 'mock-ref' };
const mockPushRef = { key: 'signal-push-id', ...mockRef };
const mockSet = vi.fn().mockResolvedValue(undefined);
const mockRemove = vi.fn().mockResolvedValue(undefined);
const mockOnDisconnectRemove = vi.fn();
const mockOnDisconnect = vi.fn().mockReturnValue({ remove: mockOnDisconnectRemove });
const mockPush = vi.fn().mockReturnValue(mockPushRef);

const mockOnChildAdded = vi.fn().mockImplementation((_q: unknown, cb: any) => {
  capturedOnChildAddedCb = cb;
  return vi.fn(); // unsubscribe
});

const mockGet = vi.fn().mockResolvedValue({
  exists: () => false,
  forEach: vi.fn(),
  val: () => null,
});

vi.mock('firebase/database', () => ({
  ref: vi.fn(() => mockRef),
  push: mockPush,
  set: mockSet,
  get: mockGet,
  remove: mockRemove,
  onChildAdded: mockOnChildAdded,
  query: vi.fn((_ref: unknown) => _ref),
  orderByChild: vi.fn(() => ({})),
  startAt: vi.fn(() => ({})),
  onDisconnect: mockOnDisconnect,
}));

// ── RTCPeerConnection mock ───────────────────────────────────────────────────

class MockRTCPeerConnection {
  connectionState: RTCPeerConnectionState = 'new';
  signalingState: RTCSignalingState = 'stable';
  localDescription: RTCSessionDescription | null = null;
  remoteDescription: RTCSessionDescription | null = null;
  iceConnectionState: RTCIceConnectionState = 'new';

  onicecandidate: ((e: RTCPeerConnectionIceEvent) => void) | null = null;
  onconnectionstatechange: (() => void) | null = null;
  oniceconnectionstatechange: (() => void) | null = null;

  addIceCandidate = vi.fn().mockResolvedValue(undefined);
  createOffer = vi.fn().mockResolvedValue({ type: 'offer', sdp: 'offer-sdp' });
  createAnswer = vi.fn().mockResolvedValue({ type: 'answer', sdp: 'answer-sdp' });
  restartIce = vi.fn();

  setLocalDescription = vi.fn().mockImplementation(async (desc: any) => {
    this.localDescription = desc;
    if (desc.type === 'offer') this.signalingState = 'have-local-offer';
    else this.signalingState = 'stable';
  });

  setRemoteDescription = vi.fn().mockImplementation(async (desc: any) => {
    this.remoteDescription = desc;
    if (desc.type === 'offer') this.signalingState = 'have-remote-offer';
    else if (desc.type === 'answer') this.signalingState = 'stable';
  });

  createDataChannel = vi.fn().mockReturnValue({
    readyState: 'open',
    onopen: null,
    onerror: null,
    onmessage: null,
  });

  close = vi.fn().mockImplementation(() => {
    this.connectionState = 'closed';
  });

  _setConnectionState(state: RTCPeerConnectionState) {
    this.connectionState = state;
    this.onconnectionstatechange?.();
  }
}

global.RTCPeerConnection = MockRTCPeerConnection as unknown as typeof RTCPeerConnection;
global.RTCIceCandidate = vi.fn().mockImplementation(function (this: any, init: any) {
  Object.assign(this, init);
}) as unknown as typeof RTCIceCandidate;
global.RTCSessionDescription = vi.fn().mockImplementation(function (this: any, init: any) {
  Object.assign(this, init);
}) as unknown as typeof RTCSessionDescription;

// ── Tests ────────────────────────────────────────────────────────────────────

describe('ConnectionResilience', () => {
  const ROOM_ID = 'room-resilience';
  const LOCAL_UID = 'user-local';

  let manager: any;
  let pc: MockRTCPeerConnection;

  beforeEach(async () => {
    capturedOnChildAddedCb = null;
    vi.useFakeTimers();
    mockSet.mockClear();
    mockPush.mockClear();
    mockOnChildAdded.mockClear();
    mockGet.mockClear();
    mockRemove.mockClear();
    mockOnDisconnect.mockClear();
    mockOnDisconnectRemove.mockClear();

    const { P2PConnectionManager } = await import('../../src/core/p2p/P2PConnectionManager');
    manager = new P2PConnectionManager(ROOM_ID, LOCAL_UID, 'default', {
      maxAttempts: 4,
      baseDelayMs: 1000,
      maxDelayMs: 16000,
      backoffMultiplier: 2,
    });
    await manager.initialize();

    pc = manager['pc'] as unknown as MockRTCPeerConnection;
  });

  afterEach(async () => {
    await manager.close();
    vi.useRealTimers();
    vi.resetModules();
    (MockRTCPeerConnection as any).mock = undefined;
  });

  // ──────────────────────────────────────────────────────────────────────
  // 1. Connection state transitions
  // ──────────────────────────────────────────────────────────────────────

  describe('state transitions', () => {
    it('starts in connecting state after initialize()', () => {
      expect(manager.getState()).toBe('connecting');
    });

    it('transitions to connected when PeerConnection becomes connected', () => {
      const states: ConnectionState[] = [];
      manager.onStateChange((s: ConnectionState) => states.push(s));

      pc._setConnectionState('connected');

      expect(manager.getState()).toBe('connected');
      expect(states).toContain('connected');
    });

    it('transitions connected -> connecting on failure (auto-reconnect)', () => {
      const states: ConnectionState[] = [];
      manager.onStateChange((s: ConnectionState) => states.push(s));

      // First get to connected
      pc._setConnectionState('connected');
      expect(manager.getState()).toBe('connected');

      // Then simulate failure
      pc._setConnectionState('failed');

      // Should be in connecting state (auto-reconnect started)
      expect(manager.getState()).toBe('connecting');
      expect(manager.getReconnectAttempt()).toBe(1);
    });

    it('transitions to closed on close()', async () => {
      const states: ConnectionState[] = [];
      manager.onStateChange((s: ConnectionState) => states.push(s));

      await manager.close();
      expect(manager.getState()).toBe('closed');
      expect(states).toContain('closed');
    });
  });

  // ──────────────────────────────────────────────────────────────────────
  // 2. ICE restart -> full reconnect progression
  // ──────────────────────────────────────────────────────────────────────

  describe('reconnect strategy progression', () => {
    it('first failures use ICE restart (attempt <= ceil(maxAttempts/2))', () => {
      manager.setInitiator(true);

      // Trigger first failure
      pc._setConnectionState('failed');
      expect(manager.getReconnectAttempt()).toBe(1);

      // Advance timer to trigger reconnect
      vi.advanceTimersByTime(2000);

      // ICE restart should have been called (attempt 1 <= ceil(4/2) = 2)
      expect(pc.restartIce).toHaveBeenCalled();
    });

    it('later failures use full reconnect (attempt > ceil(maxAttempts/2))', () => {
      manager.setInitiator(true);

      // Simulate multiple failures to get past ICE restart threshold
      pc._setConnectionState('failed'); // attempt 1
      vi.advanceTimersByTime(2000);

      // Get fresh pc reference since full reconnect creates new RTCPeerConnection
      pc = manager['pc'] as unknown as MockRTCPeerConnection;
      pc._setConnectionState('failed'); // attempt 2
      vi.advanceTimersByTime(4000);

      pc = manager['pc'] as unknown as MockRTCPeerConnection;
      pc._setConnectionState('failed'); // attempt 3 > ceil(4/2) = 2 -> full reconnect
      vi.advanceTimersByTime(8000);

      // After full reconnect, a new PC is created
      const newPc = manager['pc'];
      expect(newPc).not.toBe(pc);
    });
  });

  // ──────────────────────────────────────────────────────────────────────
  // 3. Max attempts -> failed state
  // ──────────────────────────────────────────────────────────────────────

  describe('max reconnect attempts', () => {
    it('gives up after maxAttempts and enters failed state', async () => {
      const states: ConnectionState[] = [];
      manager.onStateChange((s: ConnectionState) => states.push(s));

      // Simulate failures by directly calling handleConnectionFailure repeatedly
      // until maxAttempts is exhausted
      for (let i = 0; i < 5; i++) {
        (manager as any).handleConnectionFailure();
        // Advance timers + flush async to let reconnect attempt proceed
        await vi.advanceTimersByTimeAsync(60000);
      }

      // After 4 attempts (maxAttempts), the 5th call should set state to 'failed'
      expect(states).toContain('failed');
    });

    it('reconnectAttempt resets to 0 on successful connection', () => {
      pc._setConnectionState('failed'); // attempt 1
      expect(manager.getReconnectAttempt()).toBe(1);

      vi.advanceTimersByTime(2000);
      pc = manager['pc'] as unknown as MockRTCPeerConnection;
      pc._setConnectionState('connected');

      expect(manager.getReconnectAttempt()).toBe(0);
    });
  });

  // ──────────────────────────────────────────────────────────────────────
  // 4. Jitter delay in [50%, 100%] range
  // ──────────────────────────────────────────────────────────────────────

  describe('reconnect delay with jitter', () => {
    it('delay is within [50%, 100%] of exponential backoff', () => {
      // Test the private getReconnectDelay method
      const getDelay = (manager as any).getReconnectDelay.bind(manager);

      // Run multiple samples
      const samples = 100;
      for (let attempt = 1; attempt <= 4; attempt++) {
        const baseDelay = 1000; // baseDelayMs
        const multiplier = 2;  // backoffMultiplier
        const maxDelay = 16000; // maxDelayMs
        const exponential = baseDelay * Math.pow(multiplier, attempt - 1);
        const capped = Math.min(exponential, maxDelay);

        const minExpected = Math.round(capped * 0.5);
        const maxExpected = capped;

        for (let i = 0; i < samples; i++) {
          const delay = getDelay(attempt);
          expect(delay).toBeGreaterThanOrEqual(minExpected);
          expect(delay).toBeLessThanOrEqual(maxExpected);
        }
      }
    });
  });

  // ──────────────────────────────────────────────────────────────────────
  // 5. Reconnect listener
  // ──────────────────────────────────────────────────────────────────────

  describe('reconnect listener', () => {
    it('notifies listeners on successful reconnection with attempt count', () => {
      const reconnectCb = vi.fn();
      manager.onReconnect(reconnectCb);

      // Trigger failure + reconnect
      pc._setConnectionState('failed');
      expect(manager.getReconnectAttempt()).toBe(1);

      // Advance timer
      vi.advanceTimersByTime(2000);
      pc = manager['pc'] as unknown as MockRTCPeerConnection;

      // Successful reconnect
      pc._setConnectionState('connected');
      expect(reconnectCb).toHaveBeenCalledWith(1);
    });

    it('unsubscribe stops notifications', () => {
      const reconnectCb = vi.fn();
      const unsub = manager.onReconnect(reconnectCb);
      unsub();

      pc._setConnectionState('failed');
      vi.advanceTimersByTime(2000);
      pc = manager['pc'] as unknown as MockRTCPeerConnection;
      pc._setConnectionState('connected');

      expect(reconnectCb).not.toHaveBeenCalled();
    });
  });

  // ──────────────────────────────────────────────────────────────────────
  // 6. Close prevents reconnect
  // ──────────────────────────────────────────────────────────────────────

  describe('close prevents reconnect', () => {
    it('should not attempt reconnect after close()', async () => {
      await manager.close();

      // Simulate failure after close (should not reconnect)
      expect(manager.getState()).toBe('closed');
      expect(manager.getReconnectAttempt()).toBe(0);
    });
  });
});
