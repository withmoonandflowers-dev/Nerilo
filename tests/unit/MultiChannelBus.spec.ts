import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock firebase dependencies used by FirestoreRelay (imported by MultiChannelBus)
vi.mock('../../src/config/firebase', () => ({
  db: {} as any,
}));
vi.mock('firebase/firestore', () => ({
  collection: vi.fn(),
  addDoc: vi.fn(),
  query: vi.fn(),
  where: vi.fn(),
  onSnapshot: vi.fn().mockReturnValue(() => {}),
  serverTimestamp: vi.fn(),
  Timestamp: {
    now: vi.fn().mockReturnValue({ toMillis: () => Date.now() }),
    fromMillis: vi.fn((ms: number) => ({ toMillis: () => ms })),
  },
  getDocs: vi.fn().mockResolvedValue({ docs: [], empty: true }),
  deleteDoc: vi.fn(),
}));

import { MultiChannelBus } from '../../src/core/transport/MultiChannelBus';

function makeMockChannel(overrides: Partial<RTCDataChannel> = {}): RTCDataChannel {
  return {
    readyState: 'open',
    bufferedAmount: 0,
    bufferedAmountLowThreshold: 0,
    onmessage: null,
    onbufferedamountlow: null,
    send: vi.fn(),
    ...overrides,
  } as unknown as RTCDataChannel;
}

describe('MultiChannelBus', () => {
  let bus: MultiChannelBus;

  beforeEach(() => {
    bus = new MultiChannelBus();
  });

  describe('register / unregister', () => {
    it('registers a channel for a peer', () => {
      const ch = makeMockChannel();
      bus.register('peer-1', 'control', ch);
      expect(bus.getChannel('peer-1', 'control')).toBe(ch);
    });

    it('registers multiple channel kinds for a peer', () => {
      const ctrl = makeMockChannel();
      const bulk = makeMockChannel();
      const gossip = makeMockChannel();
      bus.register('peer-1', 'control', ctrl);
      bus.register('peer-1', 'bulk', bulk);
      bus.register('peer-1', 'gossip', gossip);
      expect(bus.getChannel('peer-1', 'control')).toBe(ctrl);
      expect(bus.getChannel('peer-1', 'bulk')).toBe(bulk);
      expect(bus.getChannel('peer-1', 'gossip')).toBe(gossip);
    });

    it('unregisters all channels for a peer', () => {
      const ch = makeMockChannel();
      bus.register('peer-1', 'control', ch);
      bus.unregister('peer-1');
      expect(bus.getChannel('peer-1', 'control')).toBeUndefined();
    });

    it('isConnected returns false after unregister', () => {
      const ch = makeMockChannel();
      bus.register('peer-1', 'control', ch);
      bus.unregister('peer-1');
      expect(bus.isConnected('peer-1')).toBe(false);
    });
  });

  describe('send', () => {
    it('sends data on the specified channel', () => {
      const ch = makeMockChannel();
      bus.register('peer-1', 'control', ch);
      bus.send('peer-1', 'control', 'hello');
      expect(ch.send).toHaveBeenCalledWith('hello');
    });

    it('throws when peer has no channels registered', () => {
      expect(() => bus.send('unknown-peer', 'control', 'data')).toThrow();
    });

    it('throws when specific channel kind not registered', () => {
      const ch = makeMockChannel();
      bus.register('peer-1', 'control', ch);
      expect(() => bus.send('peer-1', 'bulk', 'data')).toThrow();
    });

    it('does not throw when channel readyState is not open (warns instead)', () => {
      const ch = makeMockChannel({ readyState: 'closed' as RTCDataChannelState });
      bus.register('peer-1', 'control', ch);
      // Should not throw, just warn
      expect(() => bus.send('peer-1', 'control', 'data')).not.toThrow();
      expect(ch.send).not.toHaveBeenCalled();
    });
  });

  describe('broadcast', () => {
    it('sends to all registered peers', () => {
      const ch1 = makeMockChannel();
      const ch2 = makeMockChannel();
      bus.register('peer-1', 'control', ch1);
      bus.register('peer-2', 'control', ch2);
      bus.broadcast('control', 'hello');
      expect(ch1.send).toHaveBeenCalledWith('hello');
      expect(ch2.send).toHaveBeenCalledWith('hello');
    });

    it('excludes specified peer from broadcast', () => {
      const ch1 = makeMockChannel();
      const ch2 = makeMockChannel();
      bus.register('peer-1', 'control', ch1);
      bus.register('peer-2', 'control', ch2);
      bus.broadcast('control', 'hello', 'peer-1');
      expect(ch1.send).not.toHaveBeenCalled();
      expect(ch2.send).toHaveBeenCalledWith('hello');
    });

    it('does not throw if a peer send fails during broadcast', () => {
      const ch1 = makeMockChannel();
      const ch2 = makeMockChannel();
      // peer-1 has no control channel
      bus.register('peer-1', 'bulk', ch1);
      bus.register('peer-2', 'control', ch2);
      expect(() => bus.broadcast('control', 'hello')).not.toThrow();
      expect(ch2.send).toHaveBeenCalledWith('hello');
    });
  });

  describe('onMessage', () => {
    it('calls handler when a message is received', () => {
      const handler = vi.fn();
      bus.onMessage(handler);

      const ch = makeMockChannel();
      bus.register('peer-1', 'control', ch);

      // Simulate a message
      const event = new MessageEvent('message', { data: 'test-data' });
      ch.onmessage!(event);

      expect(handler).toHaveBeenCalledWith('peer-1', 'control', 'test-data');
    });

    it('multiple handlers all receive the message', () => {
      const h1 = vi.fn();
      const h2 = vi.fn();
      bus.onMessage(h1);
      bus.onMessage(h2);

      const ch = makeMockChannel();
      bus.register('peer-1', 'gossip', ch);

      const event = new MessageEvent('message', { data: 'payload' });
      ch.onmessage!(event);

      expect(h1).toHaveBeenCalledWith('peer-1', 'gossip', 'payload');
      expect(h2).toHaveBeenCalledWith('peer-1', 'gossip', 'payload');
    });
  });

  describe('connectedPeers', () => {
    it('returns peers with all channels open', () => {
      const ch = makeMockChannel();
      bus.register('peer-1', 'control', ch);
      expect(bus.connectedPeers()).toContain('peer-1');
    });

    it('excludes peers with closed channels', () => {
      const ch = makeMockChannel({ readyState: 'closed' as RTCDataChannelState });
      bus.register('peer-1', 'control', ch);
      expect(bus.connectedPeers()).not.toContain('peer-1');
    });
  });

  describe('backpressure', () => {
    it('pauses peer when bufferedAmount exceeds high watermark and resumes on bufferedamountlow', () => {
      // Mock channel with high bufferedAmount after send
      let sendCallCount = 0;
      const ch = {
        readyState: 'open',
        bufferedAmount: 0,
        bufferedAmountLowThreshold: 0,
        onmessage: null,
        onbufferedamountlow: null as (() => void) | null,
        send: vi.fn().mockImplementation(() => {
          sendCallCount++;
          // Simulate high buffered amount on first send
          if (sendCallCount === 1) {
            (ch as any).bufferedAmount = 20 * 1024 * 1024; // 20MB > bulk HWM
          }
        }),
      } as unknown as RTCDataChannel;

      bus.register('peer-1', 'bulk', ch);

      // First send - triggers backpressure after send
      bus.send('peer-1', 'bulk', 'data');
      expect(ch.send).toHaveBeenCalledTimes(1);

      // Now peer should be paused
      bus.send('peer-1', 'bulk', 'data2');
      // Second send dropped because peer is paused
      expect(ch.send).toHaveBeenCalledTimes(1);

      // Simulate bufferedamountlow event to unpause
      (ch as any).bufferedAmount = 0;
      ch.onbufferedamountlow!();

      // Now peer should be unpaused
      bus.send('peer-1', 'bulk', 'data3');
      expect(ch.send).toHaveBeenCalledTimes(2);
    });
  });
});
