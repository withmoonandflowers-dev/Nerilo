import { describe, it, expect, vi, beforeEach } from 'vitest';
import { FeatureRegistry } from '../../src/core/features/FeatureRegistry';
import type { FeatureModule, FeatureContext, Envelope } from '../../src/types';

function makeContext(overrides: Partial<FeatureContext> = {}): FeatureContext {
  return {
    selfId: 'self-1',
    roomId: 'room-1',
    send: vi.fn().mockResolvedValue(undefined),
    broadcast: vi.fn().mockResolvedValue(undefined),
    appendLedger: vi.fn().mockResolvedValue(undefined),
    store: {
      get: vi.fn().mockResolvedValue(undefined),
      set: vi.fn().mockResolvedValue(undefined),
      delete: vi.fn().mockResolvedValue(undefined),
    },
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    },
    ...overrides,
  };
}

function makeModule(
  name: string,
  namespaces: string[] = [name],
  caps: string[] = [`${name}:action`]
): FeatureModule {
  return {
    name,
    version: '1.0.0',
    namespaces,
    capabilities: caps,
    setup: vi.fn().mockResolvedValue(undefined),
    teardown: vi.fn().mockResolvedValue(undefined),
    onPeerJoin: vi.fn().mockResolvedValue(undefined),
    onPeerLeave: vi.fn().mockResolvedValue(undefined),
    handleEnvelope: vi.fn().mockResolvedValue(undefined),
  };
}

function makeEnvelope(ns: string, type: string): Envelope {
  return {
    v: 1,
    ns,
    type,
    id: `env-${Date.now()}`,
    ts: Date.now(),
    from: 'peer-1',
    roomId: 'room-1',
    payload: {},
  };
}

describe('FeatureRegistry', () => {
  let registry: FeatureRegistry;

  beforeEach(() => {
    registry = new FeatureRegistry();
  });

  describe('register', () => {
    it('registers a module successfully', () => {
      const mod = makeModule('chat');
      registry.register(mod);
      expect(registry.has('chat')).toBe(true);
      expect(registry.get('chat')).toBe(mod);
    });

    it('throws when registering duplicate module name', () => {
      const mod = makeModule('chat');
      registry.register(mod);
      expect(() => registry.register(mod)).toThrow(/already registered/i);
    });
  });

  describe('unregister', () => {
    it('calls teardown and removes module', async () => {
      const mod = makeModule('chat');
      registry.register(mod);
      await registry.unregister('chat');
      expect(registry.has('chat')).toBe(false);
      expect(mod.teardown).toHaveBeenCalled();
    });

    it('is a no-op for non-existent module', async () => {
      await expect(registry.unregister('nonexistent')).resolves.not.toThrow();
    });
  });

  describe('list', () => {
    it('returns all registered modules', () => {
      const m1 = makeModule('m1');
      const m2 = makeModule('m2');
      registry.register(m1);
      registry.register(m2);
      const list = registry.list();
      expect(list).toHaveLength(2);
      expect(list).toContain(m1);
      expect(list).toContain(m2);
    });
  });

  describe('setupAll', () => {
    it('calls setup on all modules with context', async () => {
      const m1 = makeModule('m1');
      const m2 = makeModule('m2');
      registry.register(m1);
      registry.register(m2);
      const ctx = makeContext();
      await registry.setupAll(ctx);
      expect(m1.setup).toHaveBeenCalledWith(ctx);
      expect(m2.setup).toHaveBeenCalledWith(ctx);
    });
  });

  describe('teardownAll', () => {
    it('calls teardown on all modules', async () => {
      const m1 = makeModule('m1');
      const m2 = makeModule('m2');
      registry.register(m1);
      registry.register(m2);
      await registry.teardownAll();
      expect(m1.teardown).toHaveBeenCalled();
      expect(m2.teardown).toHaveBeenCalled();
    });
  });

  describe('dispatch', () => {
    it('routes envelope to correct module by namespace', async () => {
      const chatMod = makeModule('chat', ['chat']);
      const fileMod = makeModule('file', ['file']);
      registry.register(chatMod);
      registry.register(fileMod);

      const env = makeEnvelope('chat', 'chat:MSG_SEND');
      await registry.dispatch(env);

      expect(chatMod.handleEnvelope).toHaveBeenCalledWith(env);
      expect(fileMod.handleEnvelope).not.toHaveBeenCalled();
    });

    it('dispatches to all modules matching the namespace', async () => {
      const m1 = makeModule('m1', ['shared']);
      const m2 = makeModule('m2', ['shared']);
      registry.register(m1);
      registry.register(m2);

      const env = makeEnvelope('shared', 'shared:EVENT');
      await registry.dispatch(env);

      expect(m1.handleEnvelope).toHaveBeenCalledWith(env);
      expect(m2.handleEnvelope).toHaveBeenCalledWith(env);
    });

    it('ignores modules without handleEnvelope', async () => {
      const mod = makeModule('no-handle', ['ns']);
      delete (mod as Partial<FeatureModule>).handleEnvelope;
      registry.register(mod);

      const env = makeEnvelope('ns', 'ns:EVENT');
      await expect(registry.dispatch(env)).resolves.not.toThrow();
    });
  });

  describe('notifyPeerJoin / notifyPeerLeave', () => {
    it('calls onPeerJoin on all modules', async () => {
      const m1 = makeModule('m1');
      const m2 = makeModule('m2');
      registry.register(m1);
      registry.register(m2);

      await registry.notifyPeerJoin('new-peer');
      expect(m1.onPeerJoin).toHaveBeenCalledWith('new-peer');
      expect(m2.onPeerJoin).toHaveBeenCalledWith('new-peer');
    });

    it('calls onPeerLeave on all modules', async () => {
      const m1 = makeModule('m1');
      registry.register(m1);
      await registry.notifyPeerLeave('leaving-peer');
      expect(m1.onPeerLeave).toHaveBeenCalledWith('leaving-peer');
    });
  });

  describe('getSupportedCapabilities', () => {
    it('returns union of all module capabilities', () => {
      const m1 = makeModule('m1', ['m1'], ['cap:a', 'cap:b']);
      const m2 = makeModule('m2', ['m2'], ['cap:b', 'cap:c']);
      registry.register(m1);
      registry.register(m2);

      const caps = registry.getSupportedCapabilities();
      expect(caps).toContain('cap:a');
      expect(caps).toContain('cap:b');
      expect(caps).toContain('cap:c');
      // No duplicates
      expect(caps.filter((c) => c === 'cap:b')).toHaveLength(1);
    });
  });

  describe('getSupportedNamespaces', () => {
    it('returns union of all module namespaces', () => {
      const m1 = makeModule('m1', ['ns:shared', 'ns:chat']);
      const m2 = makeModule('m2', ['ns:shared', 'ns:file']);
      registry.register(m1);
      registry.register(m2);

      const ns = registry.getSupportedNamespaces();
      expect(ns).toContain('ns:shared');
      expect(ns).toContain('ns:chat');
      expect(ns).toContain('ns:file');
      // No duplicates
      expect(ns.filter((n) => n === 'ns:shared')).toHaveLength(1);
    });
  });
});
