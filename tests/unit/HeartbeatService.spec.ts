import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { HeartbeatService } from '../../src/core/mesh/HeartbeatService';

describe('HeartbeatService', () => {
  let service: HeartbeatService;
  let sentPings: { peerId: string; msg: any }[];

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2025-01-01T00:00:00Z'));

    service = new HeartbeatService('local-node');
    sentPings = [];
    service.setSendFunction((peerId, msg) => {
      sentPings.push({ peerId, msg });
    });
  });

  afterEach(() => {
    service.stop();
    vi.useRealTimers();
  });

  it('should send pings at 30s intervals', () => {
    service.addPeer('peer-a');
    service.start(() => ['peer-a']);

    vi.advanceTimersByTime(30_000);
    expect(sentPings.length).toBe(1);
    expect(sentPings[0].peerId).toBe('peer-a');
    expect(sentPings[0].msg.type).toBe('system:ping');

    vi.advanceTimersByTime(30_000);
    expect(sentPings.length).toBe(2);
  });

  it('should calculate RTT from pong', () => {
    service.addPeer('peer-a');

    // Simulate ping sent at t=0, pong received at t=50ms
    vi.setSystemTime(new Date('2025-01-01T00:00:00.000Z'));
    const pingTimestamp = Date.now();

    vi.setSystemTime(new Date('2025-01-01T00:00:00.050Z'));
    service.handlePong(
      { type: 'system:pong', pingTimestamp, senderId: 'peer-a' },
      'peer-a'
    );

    expect(service.getLatency('peer-a')).toBe(50);
  });

  it('should classify connection quality based on RTT', () => {
    service.addPeer('peer-a');

    // RTT < 100ms → excellent
    service.handlePong({ type: 'system:pong', pingTimestamp: Date.now() - 50, senderId: 'peer-a' }, 'peer-a');
    expect(service.getConnectionQuality('peer-a')).toBe('excellent');

    // RTT 200ms → good
    service.handlePong({ type: 'system:pong', pingTimestamp: Date.now() - 200, senderId: 'peer-a' }, 'peer-a');
    expect(service.getConnectionQuality('peer-a')).toBe('good');

    // RTT 500ms → fair
    service.handlePong({ type: 'system:pong', pingTimestamp: Date.now() - 500, senderId: 'peer-a' }, 'peer-a');
    expect(service.getConnectionQuality('peer-a')).toBe('fair');

    // RTT 2000ms → poor
    service.handlePong({ type: 'system:pong', pingTimestamp: Date.now() - 2000, senderId: 'peer-a' }, 'peer-a');
    expect(service.getConnectionQuality('peer-a')).toBe('poor');
  });

  it('should mark peer as unreachable after 3 missed pings', () => {
    const unreachableNotified: string[] = [];
    service.onUnreachable((peerId) => unreachableNotified.push(peerId));

    service.addPeer('peer-a');
    service.start(() => ['peer-a']);

    // 3 ping intervals without pong
    vi.advanceTimersByTime(30_000);
    vi.advanceTimersByTime(30_000);
    vi.advanceTimersByTime(30_000);

    expect(unreachableNotified).toContain('peer-a');
    expect(service.isReachable('peer-a')).toBe(false);
  });

  it('should reset missed pings on pong', () => {
    service.addPeer('peer-a');
    service.start(() => ['peer-a']);

    vi.advanceTimersByTime(30_000); // 1 missed
    vi.advanceTimersByTime(30_000); // 2 missed

    // Receive pong → reset
    service.handlePong(
      { type: 'system:pong', pingTimestamp: Date.now() - 10, senderId: 'peer-a' },
      'peer-a'
    );

    expect(service.isReachable('peer-a')).toBe(true);
  });

  it('should create correct pong from ping', () => {
    const ping = { type: 'system:ping' as const, timestamp: 12345, senderId: 'node-x' };
    const pong = HeartbeatService.createPong(ping, 'local-node');

    expect(pong.type).toBe('system:pong');
    expect(pong.pingTimestamp).toBe(12345);
    expect(pong.senderId).toBe('local-node');
  });

  it('should return null latency for unknown peer', () => {
    expect(service.getLatency('unknown')).toBeNull();
  });

  it('getAllPeerInfo should return info for all tracked peers', () => {
    service.addPeer('a');
    service.addPeer('b');

    const info = service.getAllPeerInfo();
    expect(info.length).toBe(2);
    expect(info.map((i) => i.peerId).sort()).toEqual(['a', 'b']);
  });

  it('removePeer should clean up state', () => {
    service.addPeer('a');
    service.removePeer('a');
    expect(service.getLatency('a')).toBeNull();
    expect(service.isReachable('a')).toBe(false);
  });
});
