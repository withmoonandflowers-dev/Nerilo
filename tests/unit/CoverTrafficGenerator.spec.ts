import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { CoverTrafficGenerator } from '../../src/core/relay/CoverTrafficGenerator';

describe('CoverTrafficGenerator', () => {
  let generator: CoverTrafficGenerator;

  beforeEach(() => {
    vi.useFakeTimers();
    generator = new CoverTrafficGenerator({ enabled: true, poissonLambda: 1.0 });
  });

  afterEach(() => {
    generator.destroy();
    vi.useRealTimers();
  });

  describe('lifecycle', () => {
    it('starts and stops without errors', () => {
      const sender = vi.fn().mockResolvedValue(undefined);
      generator.setSender(sender);
      generator.start();
      expect(generator.getStats().isRunning).toBe(true);
      generator.stop();
      expect(generator.getStats().isRunning).toBe(false);
    });

    it('does not start when disabled', () => {
      const disabled = new CoverTrafficGenerator({ enabled: false });
      disabled.start();
      expect(disabled.getStats().isRunning).toBe(false);
      disabled.destroy();
    });

    it('can be enabled and disabled dynamically', () => {
      const sender = vi.fn().mockResolvedValue(undefined);
      generator.setSender(sender);
      generator.setEnabled(false);
      expect(generator.getStats().isRunning).toBe(false);
      generator.setEnabled(true);
      expect(generator.getStats().isRunning).toBe(true);
    });
  });

  describe('packet sending', () => {
    it('sends cover packets on schedule', async () => {
      const sender = vi.fn().mockResolvedValue(undefined);
      generator.setSender(sender);
      generator.start();

      // Advance time enough for packets to be sent
      await vi.advanceTimersByTimeAsync(10_000);

      expect(sender).toHaveBeenCalled();
      expect(generator.getStats().packetsSent).toBeGreaterThan(0);
    });

    it('sends packets with correct size', async () => {
      const sender = vi.fn().mockResolvedValue(undefined);
      generator.setSender(sender);
      generator.start();

      await vi.advanceTimersByTimeAsync(5000);

      if (sender.mock.calls.length > 0) {
        const payload = sender.mock.calls[0][0] as Uint8Array;
        expect(payload.length).toBe(4096); // Default packet size
      }
    });

    it('does not send without a sender function', async () => {
      generator.start();
      await vi.advanceTimersByTimeAsync(5000);
      expect(generator.getStats().packetsSent).toBe(0);
    });

    it('handles sender errors gracefully', async () => {
      const sender = vi.fn().mockRejectedValue(new Error('send failed'));
      generator.setSender(sender);
      generator.start();

      // Should not throw
      await vi.advanceTimersByTimeAsync(5000);
      expect(generator.getStats().isRunning).toBe(true);
    });
  });

  describe('configuration', () => {
    it('returns current config', () => {
      const config = generator.getConfig();
      expect(config.poissonLambda).toBe(1.0);
      expect(config.packetSize).toBe(4096);
      expect(config.enabled).toBe(true);
    });

    it('updates lambda parameter', () => {
      generator.setLambda(2.0);
      expect(generator.getConfig().poissonLambda).toBe(2.0);
    });

    it('rejects non-positive lambda', () => {
      expect(() => generator.setLambda(0)).toThrow();
      expect(() => generator.setLambda(-1)).toThrow();
    });
  });

  describe('battery awareness', () => {
    it('accepts battery status updates', () => {
      generator.setBatteryStatus(true);
      // Should reduce effective rate but not crash
      const sender = vi.fn().mockResolvedValue(undefined);
      generator.setSender(sender);
      generator.start();
      expect(generator.getStats().isRunning).toBe(true);
    });
  });

  describe('statistics', () => {
    it('tracks packets sent and last sent time', async () => {
      const sender = vi.fn().mockResolvedValue(undefined);
      generator.setSender(sender);
      generator.start();

      const initialStats = generator.getStats();
      expect(initialStats.packetsSent).toBe(0);
      expect(initialStats.lastPacketAt).toBe(0);

      await vi.advanceTimersByTimeAsync(10_000);

      const stats = generator.getStats();
      if (stats.packetsSent > 0) {
        expect(stats.lastPacketAt).toBeGreaterThan(0);
      }
    });
  });

  describe('cleanup', () => {
    it('resets state on destroy', () => {
      const sender = vi.fn().mockResolvedValue(undefined);
      generator.setSender(sender);
      generator.start();
      generator.destroy();

      expect(generator.getStats().isRunning).toBe(false);
      expect(generator.getStats().packetsSent).toBe(0);
    });
  });
});
