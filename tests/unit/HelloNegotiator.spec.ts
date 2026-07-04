/**
 * HelloNegotiator unit tests
 *
 * Covers:
 *  - sendHello dispatches HELLO envelope with self capabilities
 *  - handleEnvelope ignores non-system namespaces
 *  - HELLO → reply HELLO_ACK, record remote capabilities
 *  - HELLO_ACK completes negotiation, intersection of features computed
 *  - protocolVersion = min(local, remote)
 *  - Invalid payload ignored (no crash, no negotiation)
 *  - Timeout fires warning if peer never responds (no exception)
 *  - Repeated tryFinish does not double-invoke callback
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { HelloNegotiator, type HelloPayload } from '../../src/core/p2p/HelloNegotiator';
import type { Envelope } from '../../src/types';

const SELF_ID = 'self-peer';
const ROOM_ID = 'room-abc';

function makeSelfCapabilities(overrides: Partial<HelloPayload> = {}): HelloPayload {
  return {
    protocolVersion: 1,
    features: ['chat', 'file'],
    transports: ['control', 'bulk'],
    ...overrides,
  };
}

function makeHelloEnvelope(
  payload: HelloPayload,
  from = 'remote-peer',
  type: 'HELLO' | 'HELLO_ACK' = 'HELLO',
): Envelope<HelloPayload> {
  return {
    v: 1,
    ns: 'system',
    type,
    id: `env-${type}-${Math.random().toString(36).slice(2, 8)}`,
    ts: Date.now(),
    from,
    roomId: ROOM_ID,
    payload,
  };
}

describe('HelloNegotiator', () => {
  let sendFn: ReturnType<typeof vi.fn>;
  let negotiator: HelloNegotiator;

  beforeEach(() => {
    vi.useFakeTimers();
    sendFn = vi.fn();
    negotiator = new HelloNegotiator(makeSelfCapabilities(), sendFn, SELF_ID, ROOM_ID, 5_000);
  });

  afterEach(() => {
    negotiator.dispose();
    vi.useRealTimers();
  });

  describe('sendHello', () => {
    it('sends an envelope of type HELLO with self capabilities', () => {
      negotiator.sendHello();
      expect(sendFn).toHaveBeenCalledTimes(1);
      const env = sendFn.mock.calls[0][0] as Envelope<HelloPayload>;
      expect(env.ns).toBe('system');
      expect(env.type).toBe('HELLO');
      expect(env.from).toBe(SELF_ID);
      expect(env.roomId).toBe(ROOM_ID);
      expect(env.payload.features).toEqual(['chat', 'file']);
      expect(env.payload.protocolVersion).toBe(1);
    });

    it('starts a timeout that fires a warning when peer never responds', () => {
      negotiator.sendHello();
      // Advance just past timeout — should not throw
      expect(() => vi.advanceTimersByTime(6_000)).not.toThrow();
      expect(negotiator.isNegotiated()).toBe(false);
    });
  });

  describe('handleEnvelope', () => {
    it('returns false for non-system namespaces', () => {
      const handled = negotiator.handleEnvelope({
        v: 1,
        ns: 'chat',
        type: 'MSG',
        id: 'x',
        ts: Date.now(),
        from: 'remote-peer',
        roomId: ROOM_ID,
        payload: {},
      } as Envelope);
      expect(handled).toBe(false);
    });

    it('returns false for unknown system types', () => {
      const handled = negotiator.handleEnvelope({
        v: 1,
        ns: 'system',
        type: 'PING',
        id: 'x',
        ts: Date.now(),
        from: 'remote-peer',
        roomId: ROOM_ID,
        payload: {},
      } as Envelope);
      expect(handled).toBe(false);
    });
  });

  describe('HELLO handshake', () => {
    it('on receiving HELLO → replies with HELLO_ACK containing self capabilities', () => {
      const remote = makeSelfCapabilities({ features: ['chat', 'media'] });
      const env = makeHelloEnvelope(remote, 'peer-b', 'HELLO');

      const handled = negotiator.handleEnvelope(env);

      expect(handled).toBe(true);
      expect(sendFn).toHaveBeenCalledTimes(1);
      const ack = sendFn.mock.calls[0][0] as Envelope<HelloPayload>;
      expect(ack.type).toBe('HELLO_ACK');
      expect(ack.to).toBe('peer-b');
      expect(ack.replyTo).toBe(env.id);
      expect(ack.payload.features).toEqual(['chat', 'file']);
    });

    it('records remote capabilities and completes negotiation', () => {
      const cb = vi.fn();
      negotiator.onNegotiated(cb);

      const remote = makeSelfCapabilities({ features: ['chat', 'media'], protocolVersion: 2 });
      negotiator.handleEnvelope(makeHelloEnvelope(remote, 'peer-b', 'HELLO'));

      expect(negotiator.isNegotiated()).toBe(true);
      expect(negotiator.getRemoteCapabilities()).toEqual(remote);
      expect(cb).toHaveBeenCalledTimes(1);
      const result = cb.mock.calls[0][0];
      // Intersection: only 'chat' is in both sets
      expect(result.features).toEqual(['chat']);
      // protocolVersion = min(local=1, remote=2) = 1
      expect(result.protocolVersion).toBe(1);
      expect(result.transports).toEqual(['control', 'bulk']);
      expect(result.remote).toEqual(remote);
    });
  });

  describe('HELLO_ACK handshake', () => {
    it('completes negotiation when HELLO_ACK arrives', () => {
      const cb = vi.fn();
      negotiator.onNegotiated(cb);

      negotiator.sendHello();
      sendFn.mockClear();

      const remote = makeSelfCapabilities({ features: ['file', 'media'] });
      const handled = negotiator.handleEnvelope(makeHelloEnvelope(remote, 'peer-b', 'HELLO_ACK'));

      expect(handled).toBe(true);
      expect(negotiator.isNegotiated()).toBe(true);
      // 'file' is the only feature in both
      expect(cb.mock.calls[0][0].features).toEqual(['file']);
      // HELLO_ACK does not trigger another send
      expect(sendFn).not.toHaveBeenCalled();
    });

    it('callback fires only once even if HELLO and HELLO_ACK both arrive', () => {
      const cb = vi.fn();
      negotiator.onNegotiated(cb);

      const remote = makeSelfCapabilities();
      negotiator.handleEnvelope(makeHelloEnvelope(remote, 'peer-b', 'HELLO'));
      negotiator.handleEnvelope(makeHelloEnvelope(remote, 'peer-b', 'HELLO_ACK'));

      expect(cb).toHaveBeenCalledTimes(1);
    });
  });

  describe('invalid payloads', () => {
    it('ignores HELLO with non-object payload', () => {
      const env: Envelope = {
        v: 1, ns: 'system', type: 'HELLO',
        id: 'x', ts: Date.now(), from: 'peer-b',
        roomId: ROOM_ID, payload: 'not-an-object',
      };
      const handled = negotiator.handleEnvelope(env);
      expect(handled).toBe(true); // consumed
      expect(negotiator.isNegotiated()).toBe(false);
      expect(sendFn).not.toHaveBeenCalled();
    });

    it('ignores HELLO_ACK with missing fields', () => {
      const env: Envelope = {
        v: 1, ns: 'system', type: 'HELLO_ACK',
        id: 'x', ts: Date.now(), from: 'peer-b',
        roomId: ROOM_ID, payload: { protocolVersion: 1 /* missing features/transports */ },
      };
      const handled = negotiator.handleEnvelope(env);
      expect(handled).toBe(true);
      expect(negotiator.isNegotiated()).toBe(false);
    });

    it('ignores HELLO with non-string features', () => {
      const env: Envelope = {
        v: 1, ns: 'system', type: 'HELLO',
        id: 'x', ts: Date.now(), from: 'peer-b',
        roomId: ROOM_ID, payload: { protocolVersion: 1, features: [1, 2, 3], transports: [] },
      };
      negotiator.handleEnvelope(env);
      expect(negotiator.isNegotiated()).toBe(false);
    });
  });

  describe('dispose', () => {
    it('clears pending timeout', () => {
      negotiator.sendHello();
      negotiator.dispose();
      expect(() => vi.advanceTimersByTime(10_000)).not.toThrow();
    });
  });

  describe('strict protocols（ADR-0019：版本不合硬擋，不降級）', () => {
    function negotiateWith(local: Partial<HelloPayload>, remote: Partial<HelloPayload>) {
      const n = new HelloNegotiator(makeSelfCapabilities(local), vi.fn(), SELF_ID, ROOM_ID, 5_000);
      let result: import('../../src/core/p2p/HelloNegotiator').NegotiatedCapabilities | null = null;
      n.onNegotiated((r) => { result = r; });
      n.handleEnvelope(makeHelloEnvelope(makeSelfCapabilities(remote)));
      n.dispose();
      return result!;
    }

    it('雙方同協議同版本 → 無 mismatch', () => {
      const r = negotiateWith({ strictProtocols: { game: 2 } }, { strictProtocols: { game: 2 } });
      expect(r.strictMismatches).toEqual([]);
    });

    it('雙方同協議不同版本 → 列入 mismatch（含雙方版本）', () => {
      const r = negotiateWith({ strictProtocols: { game: 2 } }, { strictProtocols: { game: 1 } });
      expect(r.strictMismatches).toEqual([{ protocol: 'game', local: 2, remote: 1 }]);
    });

    it('對方未宣告該協議 → 不算 mismatch（feature 可用性由 features 交集決定）', () => {
      const r = negotiateWith({ strictProtocols: { game: 2 } }, {});
      expect(r.strictMismatches).toEqual([]);
    });

    it('雙方皆未宣告 → 空清單（向下相容既有 HELLO）', () => {
      const r = negotiateWith({}, {});
      expect(r.strictMismatches).toEqual([]);
    });

    it('多協議只列不合的那個', () => {
      const r = negotiateWith(
        { strictProtocols: { game: 2, sync: 1 } },
        { strictProtocols: { game: 2, sync: 3 } }
      );
      expect(r.strictMismatches).toEqual([{ protocol: 'sync', local: 1, remote: 3 }]);
    });

    it('strictProtocols 型別不合法（值非 number）→ payload 整包被拒', () => {
      const env: Envelope = {
        v: 1, ns: 'system', type: 'HELLO',
        id: 'x', ts: Date.now(), from: 'peer-b', roomId: ROOM_ID,
        payload: {
          protocolVersion: 1, features: [], transports: [],
          strictProtocols: { game: 'v2' },
        },
      };
      negotiator.handleEnvelope(env);
      expect(negotiator.isNegotiated()).toBe(false);
    });
  });
});
