/**
 * P2PProtocolRegistry unit tests
 *
 * Covers:
 *  - register validates namespace prefix and reserved names
 *  - register requires at least one type
 *  - validate enforces required envelope fields
 *  - validate rejects unknown / unregistered namespaces
 *  - validate enforces the schema's type whitelist
 *  - validate invokes the optional payload validator
 *  - getHandler / getProtocol / isRegistered / listProtocols / unregister behave as documented
 *  - Reserved namespaces cannot be unregistered
 */

import { describe, it, expect, vi } from 'vitest';
import {
  P2PProtocolRegistry,
  type ProtocolSchema,
} from '../../src/core/p2p/P2PProtocolRegistry';
import type { P2PEnvelope } from '../../src/types';

function makeEnvelope(overrides: Partial<P2PEnvelope> = {}): P2PEnvelope {
  return {
    v: 1,
    ns: 'feature.example',
    type: 'PING',
    id: 'env-1',
    ts: Date.now(),
    from: 'peer-a',
    payload: { msg: 'hello' },
    ...overrides,
  };
}

describe('P2PProtocolRegistry', () => {
  describe('register', () => {
    it('registers a custom feature namespace', () => {
      const reg = new P2PProtocolRegistry();
      const schema: ProtocolSchema = { namespace: 'feature.example', types: ['PING'] };
      reg.register(schema);
      expect(reg.isRegistered('feature.example')).toBe(true);
      expect(reg.getProtocol('feature.example')).toEqual(schema);
    });

    it('throws if namespace is reserved', () => {
      const reg = new P2PProtocolRegistry();
      for (const ns of ['system', 'chat', 'file', 'media', 'sync']) {
        expect(() => reg.register({ namespace: ns, types: ['X'] })).toThrow(/reserved/);
      }
    });

    it('throws if namespace does not start with "feature."', () => {
      const reg = new P2PProtocolRegistry();
      expect(() => reg.register({ namespace: 'custom.x', types: ['X'] })).toThrow(/feature\./);
    });

    it('throws if types list is empty', () => {
      const reg = new P2PProtocolRegistry();
      expect(() => reg.register({ namespace: 'feature.x', types: [] })).toThrow(/at least one type/);
    });

    it('stores the handler when provided', () => {
      const reg = new P2PProtocolRegistry();
      const handler = vi.fn();
      reg.register({ namespace: 'feature.x', types: ['MSG'] }, handler);
      expect(reg.getHandler('feature.x')).toBe(handler);
    });
  });

  describe('validate', () => {
    it('rejects envelope missing required fields', () => {
      const reg = new P2PProtocolRegistry();
      const result = reg.validate({
        v: 1, ns: 'chat', type: '', id: 'x', ts: Date.now(), from: 'a', payload: {},
      });
      expect(result.valid).toBe(false);
      expect(result.error).toMatch(/Missing required/);
    });

    it('accepts reserved namespaces without registration', () => {
      const reg = new P2PProtocolRegistry();
      const result = reg.validate(makeEnvelope({ ns: 'chat', type: 'MSG' }));
      expect(result.valid).toBe(true);
    });

    it('rejects unknown namespace not starting with "feature."', () => {
      const reg = new P2PProtocolRegistry();
      const result = reg.validate(makeEnvelope({ ns: 'random' }));
      expect(result.valid).toBe(false);
      expect(result.error).toMatch(/Unknown namespace/);
    });

    it('rejects unregistered feature namespace', () => {
      const reg = new P2PProtocolRegistry();
      const result = reg.validate(makeEnvelope({ ns: 'feature.ghost' }));
      expect(result.valid).toBe(false);
      expect(result.error).toMatch(/Unregistered/);
    });

    it('rejects type not in the schema type whitelist', () => {
      const reg = new P2PProtocolRegistry();
      reg.register({ namespace: 'feature.x', types: ['PING'] });
      const result = reg.validate(makeEnvelope({ ns: 'feature.x', type: 'PONG' }));
      expect(result.valid).toBe(false);
      expect(result.error).toMatch(/Invalid type/);
    });

    it('runs the schema payload validator when provided', () => {
      const reg = new P2PProtocolRegistry();
      const validator = vi.fn((p: unknown) => typeof (p as { msg?: unknown })?.msg === 'string');
      reg.register({ namespace: 'feature.x', types: ['PING'], validator });

      const ok = reg.validate(makeEnvelope({ ns: 'feature.x', type: 'PING', payload: { msg: 'hi' } }));
      expect(ok.valid).toBe(true);
      expect(validator).toHaveBeenCalledWith({ msg: 'hi' });

      const bad = reg.validate(makeEnvelope({ ns: 'feature.x', type: 'PING', payload: { wrong: 1 } }));
      expect(bad.valid).toBe(false);
      expect(bad.error).toMatch(/validation failed/);
    });
  });

  describe('lookup helpers', () => {
    it('isRegistered returns true for reserved namespaces', () => {
      const reg = new P2PProtocolRegistry();
      expect(reg.isRegistered('chat')).toBe(true);
      expect(reg.isRegistered('feature.unknown')).toBe(false);
    });

    it('listProtocols returns only registered custom protocols', () => {
      const reg = new P2PProtocolRegistry();
      reg.register({ namespace: 'feature.a', types: ['A'] });
      reg.register({ namespace: 'feature.b', types: ['B'] });
      const names = reg.listProtocols().map((p) => p.namespace).sort();
      expect(names).toEqual(['feature.a', 'feature.b']);
    });
  });

  describe('unregister', () => {
    it('removes a registered feature namespace and its handler', () => {
      const reg = new P2PProtocolRegistry();
      reg.register({ namespace: 'feature.x', types: ['X'] }, vi.fn());
      reg.unregister('feature.x');
      expect(reg.isRegistered('feature.x')).toBe(false);
      expect(reg.getHandler('feature.x')).toBeUndefined();
    });

    it('throws when trying to unregister a reserved namespace', () => {
      const reg = new P2PProtocolRegistry();
      expect(() => reg.unregister('chat')).toThrow(/Cannot unregister/);
    });
  });
});
