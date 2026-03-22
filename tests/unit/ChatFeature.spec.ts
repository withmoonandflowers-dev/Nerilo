import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ChatFeature } from '../../src/core/features/built-in/ChatFeature';
import type { FeatureContext, Envelope } from '../../src/types';

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

function makeEnvelope(type: string, payload: unknown = {}): Envelope {
  return {
    v: 1,
    ns: 'chat',
    type,
    id: `env-${Date.now()}-${Math.random()}`,
    ts: Date.now(),
    from: 'peer-1',
    roomId: 'room-1',
    payload,
  };
}

describe('ChatFeature', () => {
  let ctx: FeatureContext;

  beforeEach(async () => {
    ctx = makeContext();
    await ChatFeature.teardown(); // reset state
    await ChatFeature.setup(ctx);
  });

  describe('setup / teardown lifecycle', () => {
    it('setup calls logger info', async () => {
      expect(ctx.logger.info).toHaveBeenCalled();
    });

    it('teardown cleans up without errors', async () => {
      await expect(ChatFeature.teardown()).resolves.not.toThrow();
    });
  });

  describe('handleEnvelope - chat:MSG_SEND', () => {
    it('calls appendLedger with chat:message payload type', async () => {
      const payload = { messageId: 'msg-1', text: 'hello' };
      const env = makeEnvelope('chat:MSG_SEND', payload);
      await ChatFeature.handleEnvelope!(env);
      expect(ctx.appendLedger).toHaveBeenCalledWith('chat:message', payload);
    });
  });

  describe('handleEnvelope - chat:MSG_EDIT', () => {
    it('calls appendLedger with chat:edit payload type', async () => {
      const payload = { messageId: 'msg-1', newText: 'edited', editedAt: Date.now() };
      const env = makeEnvelope('chat:MSG_EDIT', payload);
      await ChatFeature.handleEnvelope!(env);
      expect(ctx.appendLedger).toHaveBeenCalledWith('chat:edit', payload);
    });
  });

  describe('handleEnvelope - chat:MSG_DELETE', () => {
    it('calls appendLedger with chat:delete payload type', async () => {
      const payload = { messageId: 'msg-1', deletedAt: Date.now() };
      const env = makeEnvelope('chat:MSG_DELETE', payload);
      await ChatFeature.handleEnvelope!(env);
      expect(ctx.appendLedger).toHaveBeenCalledWith('chat:delete', payload);
    });
  });

  describe('handleEnvelope - chat:TYPING', () => {
    it('does NOT call appendLedger (not persisted)', async () => {
      const payload = { userId: 'peer-1', isTyping: true };
      const env = makeEnvelope('chat:TYPING', payload);
      await ChatFeature.handleEnvelope!(env);
      expect(ctx.appendLedger).not.toHaveBeenCalled();
    });

    it('logs the typing indicator', async () => {
      const payload = { userId: 'peer-1', isTyping: true };
      const env = makeEnvelope('chat:TYPING', payload);
      await ChatFeature.handleEnvelope!(env);
      expect(ctx.logger.info).toHaveBeenCalled();
    });
  });

  describe('handleEnvelope - chat:REACT', () => {
    it('calls appendLedger with chat:react payload type', async () => {
      const payload = { messageId: 'msg-1', emoji: '👍', userId: 'peer-1' };
      const env = makeEnvelope('chat:REACT', payload);
      await ChatFeature.handleEnvelope!(env);
      expect(ctx.appendLedger).toHaveBeenCalledWith('chat:react', payload);
    });
  });

  describe('handleEnvelope - unknown type', () => {
    it('ignores unknown envelope types gracefully', async () => {
      const env = makeEnvelope('chat:UNKNOWN_TYPE', {});
      await expect(ChatFeature.handleEnvelope!(env)).resolves.not.toThrow();
      expect(ctx.appendLedger).not.toHaveBeenCalled();
    });
  });

  describe('onPeerJoin / onPeerLeave', () => {
    it('onPeerJoin resolves without error', async () => {
      await expect(ChatFeature.onPeerJoin!('new-peer')).resolves.not.toThrow();
    });

    it('onPeerLeave resolves without error', async () => {
      await expect(ChatFeature.onPeerLeave!('old-peer')).resolves.not.toThrow();
    });
  });

  describe('module metadata', () => {
    it('has correct name and version', () => {
      expect(ChatFeature.name).toBe('chat');
      expect(ChatFeature.version).toBe('1.0.0');
    });

    it('includes expected capabilities', () => {
      expect(ChatFeature.capabilities).toContain('chat:send');
      expect(ChatFeature.capabilities).toContain('chat:edit');
      expect(ChatFeature.capabilities).toContain('chat:delete');
      expect(ChatFeature.capabilities).toContain('chat:react');
      expect(ChatFeature.capabilities).toContain('chat:typing');
    });

    it('namespace includes chat', () => {
      expect(ChatFeature.namespaces).toContain('chat');
    });
  });
});
