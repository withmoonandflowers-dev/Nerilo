import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { PeerScoring } from '../../src/core/relay/PeerScoring';

describe('PeerScoring', () => {
  let scoring: PeerScoring;

  beforeEach(() => {
    scoring = new PeerScoring();
  });

  afterEach(() => {
    scoring.destroy();
  });

  describe('peer lifecycle', () => {
    it('adds a peer with neutral starting score', () => {
      scoring.addPeer('node-1');
      const score = scoring.getPeerScore('node-1');
      expect(score).toBeDefined();
      expect(score!.compositeScore).toBeGreaterThanOrEqual(-5);
      expect(score!.compositeScore).toBeLessThanOrEqual(50);
    });

    it('does not duplicate peers', () => {
      scoring.addPeer('node-1');
      scoring.addPeer('node-1');
      expect(scoring.getRankedPeers()).toHaveLength(1);
    });

    it('removes a peer', () => {
      scoring.addPeer('node-1');
      scoring.removePeer('node-1');
      expect(scoring.getPeerScore('node-1')).toBeUndefined();
    });
  });

  describe('scoring', () => {
    it('increases score on successful deliveries', () => {
      scoring.addPeer('node-1');
      const initial = scoring.getScore('node-1');
      for (let i = 0; i < 10; i++) scoring.recordDelivery('node-1');
      expect(scoring.getScore('node-1')).toBeGreaterThan(initial);
    });

    it('decreases score on delivery failures', () => {
      scoring.addPeer('node-1');
      for (let i = 0; i < 5; i++) scoring.recordDelivery('node-1');
      const afterGood = scoring.getScore('node-1');
      for (let i = 0; i < 10; i++) scoring.recordDeliveryFailure('node-1');
      expect(scoring.getScore('node-1')).toBeLessThan(afterGood);
    });

    it('penalizes invalid messages', () => {
      scoring.addPeer('node-1');
      const initial = scoring.getScore('node-1');
      for (let i = 0; i < 5; i++) scoring.recordInvalidMessage('node-1');
      expect(scoring.getScore('node-1')).toBeLessThan(initial);
    });

    it('tracks first arrival rate', () => {
      scoring.addPeer('node-1');
      for (let i = 0; i < 10; i++) scoring.recordFirstArrival('node-1');
      const score = scoring.getPeerScore('node-1');
      expect(score!.firstArrivalRate).toBeGreaterThan(0);
    });
  });

  describe('thresholds', () => {
    it('graylists peers with very low scores', () => {
      scoring.addPeer('bad-node');
      for (let i = 0; i < 20; i++) scoring.recordInvalidMessage('bad-node');
      expect(scoring.isGraylisted('bad-node')).toBe(true);
    });

    it('marks relay-eligible peers with high scores', () => {
      scoring.addPeer('good-node');
      for (let i = 0; i < 50; i++) scoring.recordDelivery('good-node');
      scoring.recordMeshPresence('good-node', 3600_000);
      expect(scoring.isRelayEligible('good-node')).toBe(true);
    });

    it('returns ranked peers in descending score order', () => {
      scoring.addPeer('node-a');
      scoring.addPeer('node-b');
      for (let i = 0; i < 20; i++) scoring.recordDelivery('node-a');
      for (let i = 0; i < 5; i++) scoring.recordInvalidMessage('node-b');

      const ranked = scoring.getRankedPeers();
      expect(ranked[0].nodeId).toBe('node-a');
      expect(ranked[1].nodeId).toBe('node-b');
    });
  });

  describe('IP colocation detection', () => {
    it('detects peers sharing the same IP', () => {
      scoring.addPeer('node-1', 'ip-hash-A');
      scoring.addPeer('node-2', 'ip-hash-A');
      scoring.addPeer('node-3', 'ip-hash-B');

      expect(scoring.getColocationCount('node-1')).toBe(2);
      expect(scoring.getColocationCount('node-3')).toBe(1);
    });

    it('reduces colocation count on peer removal', () => {
      scoring.addPeer('node-1', 'ip-hash-A');
      scoring.addPeer('node-2', 'ip-hash-A');
      scoring.removePeer('node-2');
      expect(scoring.getColocationCount('node-1')).toBe(1);
    });
  });
});
