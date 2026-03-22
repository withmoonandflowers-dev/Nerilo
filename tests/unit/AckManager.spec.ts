import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { AckManager } from '../../src/core/protocol/AckManager';
import type { Envelope } from '../../src/types';

function makeEnvelope(id: string): Envelope {
  return {
    v: 1,
    ns: 'test',
    type: 'test:MSG',
    id,
    ts: Date.now(),
    from: 'sender',
    roomId: 'room-1',
    payload: {},
  };
}

describe('AckManager', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('track', () => {
    it('tracks an envelope and schedules retry after timeoutMs', async () => {
      const sendFn = vi.fn().mockResolvedValue(undefined);
      const ackMgr = new AckManager(sendFn, 3, 1000);
      const env = makeEnvelope('env-1');

      ackMgr.track('peer-1', env);
      expect(ackMgr.hasPending('peer-1')).toBe(true);
      expect(ackMgr.pendingCount('peer-1')).toBe(1);

      // Advance time to trigger first retry
      await vi.advanceTimersByTimeAsync(1000);
      expect(sendFn).toHaveBeenCalledTimes(1);

      ackMgr.dispose();
    });

    it('does not track the same envelope twice', () => {
      const sendFn = vi.fn().mockResolvedValue(undefined);
      const ackMgr = new AckManager(sendFn);
      const env = makeEnvelope('env-dup');

      ackMgr.track('peer-1', env);
      ackMgr.track('peer-1', env); // second call should be no-op
      expect(ackMgr.pendingCount('peer-1')).toBe(1);

      ackMgr.dispose();
    });
  });

  describe('ack', () => {
    it('clears pending envelope on ack, preventing retries', async () => {
      const sendFn = vi.fn().mockResolvedValue(undefined);
      const ackMgr = new AckManager(sendFn, 3, 1000);
      const env = makeEnvelope('env-ack');

      ackMgr.track('peer-1', env);
      ackMgr.ack(env.id);

      expect(ackMgr.hasPending('peer-1')).toBe(false);

      // Advance timers - send should NOT be called (acked already)
      await vi.advanceTimersByTimeAsync(5000);
      expect(sendFn).not.toHaveBeenCalled();
    });

    it('is a no-op for unknown replyTo', () => {
      const sendFn = vi.fn();
      const ackMgr = new AckManager(sendFn);
      expect(() => ackMgr.ack('unknown-id')).not.toThrow();
    });
  });

  describe('nack', () => {
    it('cancels tracking and calls onPeerUnstable', () => {
      const sendFn = vi.fn();
      const onPeerUnstable = vi.fn();
      const ackMgr = new AckManager(sendFn, 3, 1000, onPeerUnstable);
      const env = makeEnvelope('env-nack');

      ackMgr.track('peer-1', env);
      ackMgr.nack(env.id);

      expect(ackMgr.hasPending('peer-1')).toBe(false);
      expect(onPeerUnstable).toHaveBeenCalledWith('peer-1');
    });
  });

  describe('maxRetries exceeded', () => {
    it('calls onPeerUnstable after maxRetries and removes from pending', async () => {
      const sendFn = vi.fn().mockResolvedValue(undefined);
      const onPeerUnstable = vi.fn();
      const maxRetries = 2;
      const timeoutMs = 500;
      const ackMgr = new AckManager(sendFn, maxRetries, timeoutMs, onPeerUnstable);
      const env = makeEnvelope('env-retry');

      ackMgr.track('peer-1', env);

      // Trigger retries
      for (let i = 0; i <= maxRetries; i++) {
        await vi.advanceTimersByTimeAsync(timeoutMs);
      }

      expect(onPeerUnstable).toHaveBeenCalledWith('peer-1');
      expect(ackMgr.hasPending('peer-1')).toBe(false);
    });
  });

  describe('hasPending / pendingCount', () => {
    it('returns false for peer with no pending', () => {
      const ackMgr = new AckManager(vi.fn());
      expect(ackMgr.hasPending('no-peer')).toBe(false);
      expect(ackMgr.pendingCount('no-peer')).toBe(0);
    });

    it('counts correctly for multiple envelopes', () => {
      const ackMgr = new AckManager(vi.fn().mockResolvedValue(undefined));
      ackMgr.track('peer-1', makeEnvelope('e1'));
      ackMgr.track('peer-1', makeEnvelope('e2'));
      ackMgr.track('peer-2', makeEnvelope('e3'));

      expect(ackMgr.pendingCount('peer-1')).toBe(2);
      expect(ackMgr.pendingCount('peer-2')).toBe(1);

      ackMgr.dispose();
    });
  });

  describe('dispose', () => {
    it('clears all timeouts and pending entries', async () => {
      const sendFn = vi.fn().mockResolvedValue(undefined);
      const ackMgr = new AckManager(sendFn, 3, 1000);

      ackMgr.track('peer-1', makeEnvelope('e1'));
      ackMgr.track('peer-1', makeEnvelope('e2'));
      ackMgr.dispose();

      expect(ackMgr.hasPending('peer-1')).toBe(false);

      // After dispose, no retries should fire
      await vi.advanceTimersByTimeAsync(10000);
      expect(sendFn).not.toHaveBeenCalled();
    });
  });
});
