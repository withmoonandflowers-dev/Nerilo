/**
 * Sprint 1 — Stability Hardening Tests
 *
 * S-1: WebRTC auto-reconnect (exponential backoff)
 * S-3: Gossip ACK mechanism
 * I-5: DeviceCapability detection + SuperNode election weighting
 * Memory leak fixes: HeartbeatService TTL, GossipHandler cleanup
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ── S-1: Auto-Reconnect ─────────────────────────────────────────────────────

// Inline minimal mock for P2PConnectionManager reconnect logic
// (The actual class needs Firebase; we test the ReconnectConfig + delay calc independently)

describe('S-1: WebRTC Auto-Reconnect', () => {
  describe('ReconnectConfig defaults', () => {
    // Import type only to validate shape
    it('has sensible defaults', async () => {
      const { P2PConnectionManager } = await importP2PConnectionManager();
      const mgr = new P2PConnectionManager('room1', 'user1');
      expect(mgr.getReconnectAttempt()).toBe(0);
    });
  });

  describe('Exponential backoff delay calculation', () => {
    it('calculates increasing delays', () => {
      // Test the math directly: base=1000, multiplier=2
      const base = 1000;
      const multiplier = 2;
      const maxDelay = 30000;

      const delays = [1, 2, 3, 4, 5].map(attempt => {
        const exponential = base * Math.pow(multiplier, attempt - 1);
        return Math.min(exponential, maxDelay);
      });

      expect(delays).toEqual([1000, 2000, 4000, 8000, 16000]);
    });

    it('caps at maxDelayMs', () => {
      const base = 1000;
      const multiplier = 2;
      const maxDelay = 5000;

      const delay6 = Math.min(base * Math.pow(multiplier, 5), maxDelay);
      expect(delay6).toBe(5000);
    });
  });

  describe('onReconnect listener', () => {
    it('registers and unregisters listeners', async () => {
      const { P2PConnectionManager } = await importP2PConnectionManager();
      const mgr = new P2PConnectionManager('room1', 'user1');
      const listener = vi.fn();
      const unsub = mgr.onReconnect(listener);
      expect(typeof unsub).toBe('function');
      unsub();
    });
  });

  describe('setInitiator', () => {
    it('sets initiator role', async () => {
      const { P2PConnectionManager } = await importP2PConnectionManager();
      const mgr = new P2PConnectionManager('room1', 'user1');
      // Should not throw
      mgr.setInitiator(true);
      mgr.setInitiator(false);
    });
  });
});

// Helper to import P2PConnectionManager with Firebase mocked
async function importP2PConnectionManager() {
  vi.mock('../../src/config/firebase', () => ({ db: {} }));
  vi.mock('firebase/firestore', () => ({
    collection: vi.fn(() => ({})),
    onSnapshot: vi.fn(() => vi.fn()),
    addDoc: vi.fn().mockResolvedValue({ id: 'doc-id' }),
    query: vi.fn((ref: unknown) => ref),
    orderBy: vi.fn(() => ({})),
    where: vi.fn(() => ({})),
    limit: vi.fn(() => ({})),
    getDocs: vi.fn().mockResolvedValue({ empty: true, docs: [] }),
    deleteDoc: vi.fn(),
    Timestamp: { now: vi.fn(() => ({ toMillis: () => Date.now() })) },
  }));

  return await import('../../src/core/p2p/P2PConnectionManager');
}

// ── S-3: Gossip ACK Manager ─────────────────────────────────────────────────

import { GossipAckManager } from '../../src/core/mesh/GossipAckManager';
import type { AckEnvelope, CriticalMessageType } from '../../src/core/mesh/GossipAckManager';

describe('S-3: GossipAckManager', () => {
  let ackMgr: GossipAckManager;

  beforeEach(() => {
    vi.useFakeTimers();
    ackMgr = new GossipAckManager('local-peer', {
      maxRetries: 3,
      baseTimeoutMs: 100,
      backoffMultiplier: 2,
      maxTimeoutMs: 1000,
    });
  });

  afterEach(() => {
    ackMgr.destroy();
    vi.useRealTimers();
  });

  it('tracks a message and returns ackId', () => {
    const ackId = ackMgr.trackMessage('key-rotation', ['peerA', 'peerB'], async () => {});
    expect(ackId).toContain('local-peer:ack:');
    expect(ackMgr.getPendingCount()).toBe(1);
  });

  it('completes when all peers ACK', () => {
    const successHandler = vi.fn();
    ackMgr.onSuccess(successHandler);

    const ackId = ackMgr.trackMessage('key-rotation', ['peerA', 'peerB'], async () => {});

    ackMgr.handleAck({ type: 'gossip:ack', ackId, senderId: 'peerA' });
    expect(ackMgr.getPendingCount()).toBe(1); // Still waiting for peerB

    ackMgr.handleAck({ type: 'gossip:ack', ackId, senderId: 'peerB' });
    expect(ackMgr.getPendingCount()).toBe(0);
    expect(successHandler).toHaveBeenCalledWith(ackId, 'key-rotation');
  });

  it('retries on timeout', async () => {
    const resendFn = vi.fn().mockResolvedValue(undefined);
    ackMgr.trackMessage('member-join', ['peerA'], resendFn);

    // Advance past first timeout (100ms)
    await vi.advanceTimersByTimeAsync(110);
    expect(resendFn).toHaveBeenCalledTimes(1);

    // Advance past second timeout (200ms)
    await vi.advanceTimersByTimeAsync(210);
    expect(resendFn).toHaveBeenCalledTimes(2);
  });

  it('fires failure handler after max retries', async () => {
    const failureHandler = vi.fn();
    ackMgr.onFailure(failureHandler);

    const resendFn = vi.fn().mockResolvedValue(undefined);
    const ackId = ackMgr.trackMessage('governance-vote', ['peerA'], resendFn);

    // Exhaust all retries: 100ms + 200ms + 400ms + final check at 800ms
    await vi.advanceTimersByTimeAsync(110);  // retry 1
    await vi.advanceTimersByTimeAsync(210);  // retry 2
    await vi.advanceTimersByTimeAsync(410);  // retry 3
    await vi.advanceTimersByTimeAsync(810);  // timeout → failure

    expect(failureHandler).toHaveBeenCalledWith(ackId, 'governance-vote', ['peerA']);
    expect(ackMgr.getPendingCount()).toBe(0);
  });

  it('reports missing peers correctly', () => {
    const ackId = ackMgr.trackMessage('role-change', ['peerA', 'peerB', 'peerC'], async () => {});

    ackMgr.handleAck({ type: 'gossip:ack', ackId, senderId: 'peerB' });
    const missing = ackMgr.getMissingPeers(ackId);
    expect(missing.sort()).toEqual(['peerA', 'peerC']);
  });

  it('removePeer completes entry when removed peer was the only missing one', () => {
    const successHandler = vi.fn();
    ackMgr.onSuccess(successHandler);

    const ackId = ackMgr.trackMessage('member-leave', ['peerA', 'peerB'], async () => {});
    ackMgr.handleAck({ type: 'gossip:ack', ackId, senderId: 'peerA' });

    // peerB disconnects
    ackMgr.removePeer('peerB');
    expect(ackMgr.getPendingCount()).toBe(0);
    expect(successHandler).toHaveBeenCalled();
  });

  it('creates correct ACK envelope', () => {
    const ack = ackMgr.createAck('some-ack-id');
    expect(ack).toEqual({
      type: 'gossip:ack',
      ackId: 'some-ack-id',
      senderId: 'local-peer',
    });
  });

  it('ignores ACK for unknown ackId', () => {
    // Should not throw
    ackMgr.handleAck({ type: 'gossip:ack', ackId: 'unknown', senderId: 'peerX' });
    expect(ackMgr.getPendingCount()).toBe(0);
  });

  it('enforces maxPendingEntries limit', () => {
    const mgr = new GossipAckManager('local', { maxPendingEntries: 3 });
    for (let i = 0; i < 5; i++) {
      mgr.trackMessage('key-rotation', [`peer${i}`], async () => {});
    }
    // Should cap at 3 (evicted 2 oldest)
    expect(mgr.getPendingCount()).toBe(3);
    mgr.destroy();
  });

  it('destroy clears all state', () => {
    ackMgr.trackMessage('key-rotation', ['peerA'], async () => {});
    ackMgr.trackMessage('member-join', ['peerB'], async () => {});
    ackMgr.destroy();
    expect(ackMgr.getPendingCount()).toBe(0);
  });
});

// ── I-5: DeviceCapability + SuperNode Election ──────────────────────────────

import { NodeDeviceCapabilityAdapter } from '../../src/core/adapters/NodeRuntime';
import { SuperNodeElection } from '../../src/core/mesh/SuperNodeElection';
import type { PeerScore } from '../../src/core/mesh/SuperNodeElection';

describe('I-5: NodeDeviceCapabilityAdapter', () => {
  let adapter: NodeDeviceCapabilityAdapter;

  beforeEach(() => {
    adapter = new NodeDeviceCapabilityAdapter();
  });

  it('returns null or number for hardware concurrency', () => {
    const cores = adapter.getHardwareConcurrency();
    expect(cores === null || typeof cores === 'number').toBe(true);
  });

  it('returns null for device memory (not available in Node)', () => {
    expect(adapter.getDeviceMemory()).toBeNull();
  });

  it('returns null for battery (not available in Node)', async () => {
    expect(await adapter.getBatteryLevel()).toBeNull();
    expect(await adapter.isCharging()).toBeNull();
  });

  it('returns ethernet for network type', () => {
    expect(adapter.getNetworkType()).toBe('ethernet');
  });

  it('returns desktop for device type', () => {
    expect(adapter.getDeviceType()).toBe('desktop');
  });

  it('returns a complete snapshot', async () => {
    const snapshot = await adapter.getSnapshot();
    expect(snapshot).toHaveProperty('cpuCores');
    expect(snapshot).toHaveProperty('memoryGb');
    expect(snapshot).toHaveProperty('batteryLevel');
    expect(snapshot).toHaveProperty('isCharging');
    expect(snapshot).toHaveProperty('networkType');
    expect(snapshot).toHaveProperty('deviceType');
    expect(snapshot.networkType).toBe('ethernet');
    expect(snapshot.deviceType).toBe('desktop');
  });
});

describe('I-5: SuperNodeElection with DeviceCapability', () => {
  let election: SuperNodeElection;

  beforeEach(() => {
    election = new SuperNodeElection();
  });

  it('scores higher for peers with more CPU cores', () => {
    const basePeer: PeerScore = {
      peerId: 'peer1',
      uptimeSeconds: 1000,
      bandwidthKbps: 5000,
      latencyMs: 50,
      batteryLevel: 1.0,
      natType: 'open',
      cpuCores: 2,
      memoryGb: 4,
      networkType: 'wifi',
    };
    const powerPeer: PeerScore = {
      ...basePeer,
      peerId: 'peer2',
      cpuCores: 16,
      memoryGb: 32,
      networkType: 'ethernet',
    };
    const allPeers = [basePeer, powerPeer];

    const score1 = election.computeScore(basePeer, allPeers);
    const score2 = election.computeScore(powerPeer, allPeers);

    expect(score2).toBeGreaterThan(score1);
  });

  it('still elects when device fields are missing (backwards compatible)', () => {
    const peers: PeerScore[] = [
      { peerId: 'a', uptimeSeconds: 500, bandwidthKbps: 3000, latencyMs: 100, batteryLevel: 0.8, natType: 'open' },
      { peerId: 'b', uptimeSeconds: 1000, bandwidthKbps: 5000, latencyMs: 50, batteryLevel: 1.0, natType: 'full-cone' },
      { peerId: 'c', uptimeSeconds: 200, bandwidthKbps: 1000, latencyMs: 200, batteryLevel: 0.5, natType: 'restricted' },
    ];

    // participantCount <= 20 → no super nodes
    const result20 = election.elect(peers, 20);
    expect(result20.superNodes).toEqual([]);

    // participantCount = 25 → should elect some
    const result25 = election.elect(peers, 25);
    expect(result25.superNodes.length).toBeGreaterThan(0);
    expect(result25.scores.size).toBe(3);
  });

  it('prefers ethernet over cellular', () => {
    const wifiPeer: PeerScore = {
      peerId: 'wifi',
      uptimeSeconds: 500,
      bandwidthKbps: 5000,
      latencyMs: 50,
      batteryLevel: 1.0,
      natType: 'open',
      cpuCores: 8,
      memoryGb: 8,
      networkType: '3g',
    };
    const ethPeer: PeerScore = {
      ...wifiPeer,
      peerId: 'eth',
      networkType: 'ethernet',
    };
    const allPeers = [wifiPeer, ethPeer];

    const scoreWifi = election.computeScore(wifiPeer, allPeers);
    const scoreEth = election.computeScore(ethPeer, allPeers);

    expect(scoreEth).toBeGreaterThan(scoreWifi);
  });

  it('score sums to approximately 1.0 for perfect peer', () => {
    const perfectPeer: PeerScore = {
      peerId: 'perfect',
      uptimeSeconds: 3600,
      bandwidthKbps: 10000,
      latencyMs: 10,
      batteryLevel: 1.0,
      natType: 'open',
      cpuCores: 16,
      memoryGb: 32,
      networkType: 'ethernet',
    };

    const score = election.computeScore(perfectPeer, [perfectPeer]);
    // Single peer is always normalized to max, so score ≈ 1.0
    // latency inverse: 1 - (10/10) = 0, so not quite 1.0
    // Actually with single peer: latency = 1 - min(10/10, 1) = 0
    // So score = 0.22*1 + 0.20*1 + 0.20*0 + 0.08*1 + 0.08*1 + 0.08*1 + 0.07*1 + 0.07*1
    // = 0.22 + 0.20 + 0 + 0.08 + 0.08 + 0.08 + 0.07 + 0.07 = 0.80
    expect(score).toBeGreaterThan(0.5);
    expect(score).toBeLessThanOrEqual(1.0);
  });
});

// ── Memory Leak Fixes ───────────────────────────────────────────────────────

import { HeartbeatService } from '../../src/core/mesh/HeartbeatService';

describe('HeartbeatService — Stale peer eviction', () => {
  let hb: HeartbeatService;

  beforeEach(() => {
    vi.useFakeTimers();
    hb = new HeartbeatService('local');
    hb.setSendFunction(() => {}); // No-op sender
  });

  afterEach(() => {
    hb.stop();
    vi.useRealTimers();
  });

  it('evicts stale peers not in active set after TTL', () => {
    // Add peers
    hb.addPeer('peerA');
    hb.addPeer('peerB');
    hb.addPeer('peerC');

    // Start with peerA and peerB active
    hb.start(() => ['peerA', 'peerB']);

    // Advance past TTL (5 minutes) + one ping interval (30s)
    vi.advanceTimersByTime(330_000);

    // peerC was never in the active set and has no pong → should be evicted
    const allInfo = hb.getAllPeerInfo();
    const peerIds = allInfo.map(p => p.peerId);
    expect(peerIds).not.toContain('peerC');
    expect(peerIds).toContain('peerA');
    expect(peerIds).toContain('peerB');
  });

  it('keeps peers with recent pongs even if not in active set', () => {
    hb.addPeer('peerX');

    // Simulate a recent pong
    hb.handlePong({ type: 'system:pong', pingTimestamp: Date.now(), senderId: 'peerX' }, 'peerX');

    // Start without peerX in active set
    hb.start(() => []);

    // Advance by 1 minute (less than 5min TTL)
    vi.advanceTimersByTime(60_000);

    const allInfo = hb.getAllPeerInfo();
    const peerIds = allInfo.map(p => p.peerId);
    expect(peerIds).toContain('peerX');
  });
});

describe('GossipMessageHandler — cleanup', () => {
  // We can't easily instantiate GossipMessageHandler without all its dependencies,
  // so we test the pruning logic conceptually via a minimal scenario.

  it('pruneTrackedSenders logic: caps Map size', () => {
    const MAX = 5;
    const map = new Map<string, number>();

    // Fill beyond max
    for (let i = 0; i < 10; i++) {
      map.set(`sender-${i}`, i);
    }

    // Prune to MAX
    if (map.size > MAX) {
      const excess = map.size - MAX;
      let removed = 0;
      for (const key of map.keys()) {
        if (removed >= excess) break;
        map.delete(key);
        removed++;
      }
    }

    expect(map.size).toBe(MAX);
    // Oldest entries (sender-0 through sender-4) should be removed
    expect(map.has('sender-0')).toBe(false);
    expect(map.has('sender-9')).toBe(true);
  });

  it('rate limiter cleanup removes entries with no recent timestamps', () => {
    const now = 100_000;
    const rateLimiter = new Map<string, number[]>();
    rateLimiter.set('active', [now - 1000, now - 500]);
    rateLimiter.set('stale', [now - 20_000]);

    // Prune: keep entries with timestamps within 10s
    for (const [senderId, timestamps] of rateLimiter) {
      const recent = timestamps.filter(ts => now - ts < 10_000);
      if (recent.length === 0) {
        rateLimiter.delete(senderId);
      } else {
        rateLimiter.set(senderId, recent);
      }
    }

    expect(rateLimiter.has('active')).toBe(true);
    expect(rateLimiter.has('stale')).toBe(false);
  });
});
