/**
 * P2PChannelBus unit tests
 *
 * Mocks RTCDataChannel and verifies:
 *  - Constructor wires up onmessage/onopen/onclose/onerror handlers
 *  - subscribe() routes parsed messages by namespace; wildcard ('*') receives all
 *  - send() rejects when channel is null
 *  - send() queues when channel is not open
 *  - send() queues when bufferedAmount exceeds threshold
 *  - close() clears handlers and queue
 *  - getReadyState / getBufferedAmount surface channel state
 *  - subscribe returns unsubscribe function
 *  - Parse errors emit a system ERROR envelope
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { P2PChannelBus } from '../../src/core/p2p/P2PChannelBus';
import type { P2PEnvelope } from '../../src/types';

interface MockDataChannel {
  readyState: RTCDataChannelState;
  bufferedAmount: number;
  bufferedAmountLowThreshold: number;
  label: string;
  onmessage: ((event: { data: string }) => void) | null;
  onerror: ((event: Event) => void) | null;
  onclose: (() => void) | null;
  onopen: (() => void) | null;
  onbufferedamountlow: (() => void) | null;
  send: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
}

function makeMockChannel(overrides: Partial<MockDataChannel> = {}): MockDataChannel {
  return {
    readyState: 'open',
    bufferedAmount: 0,
    bufferedAmountLowThreshold: 0,
    label: 'test-channel',
    onmessage: null,
    onerror: null,
    onclose: null,
    onopen: null,
    onbufferedamountlow: null,
    send: vi.fn(),
    close: vi.fn(),
    ...overrides,
  };
}

function makeEnvelope(ns = 'chat', type = 'MSG'): P2PEnvelope {
  return {
    v: 1,
    ns,
    type,
    id: `env-${Math.random().toString(36).slice(2, 8)}`,
    ts: Date.now(),
    from: 'peer-a',
    payload: { hello: 'world' },
  };
}

describe('P2PChannelBus', () => {
  let channel: MockDataChannel;
  let bus: P2PChannelBus;

  beforeEach(() => {
    channel = makeMockChannel();
    bus = new P2PChannelBus(channel as unknown as RTCDataChannel);
  });

  describe('lifecycle', () => {
    it('attaches handlers on construction', () => {
      expect(channel.onmessage).toBeTypeOf('function');
      expect(channel.onerror).toBeTypeOf('function');
      expect(channel.onclose).toBeTypeOf('function');
      expect(channel.onopen).toBeTypeOf('function');
      expect(channel.onbufferedamountlow).toBeTypeOf('function');
    });

    it('sets bufferedAmountLowThreshold to 64KB', () => {
      expect(channel.bufferedAmountLowThreshold).toBe(64 * 1024);
    });

    it('getReadyState returns the channel state', () => {
      expect(bus.getReadyState()).toBe('open');
    });

    it('getBufferedAmount returns the channel bufferedAmount', () => {
      channel.bufferedAmount = 512;
      expect(bus.getBufferedAmount()).toBe(512);
    });

    it('close() closes the channel and clears handlers', () => {
      bus.close();
      expect(channel.close).toHaveBeenCalled();
      // After close, readyState falls back to 'closed' (channel ref null)
      expect(bus.getReadyState()).toBe('closed');
    });
  });

  describe('subscribe & message routing', () => {
    it('routes parsed envelope to the matching namespace handler', async () => {
      const handler = vi.fn();
      bus.subscribe('chat', handler);

      const env = makeEnvelope('chat', 'MSG');
      channel.onmessage!({ data: JSON.stringify(env) });
      // handleMessage is async; let microtasks flush
      await Promise.resolve();
      await Promise.resolve();

      expect(handler).toHaveBeenCalledTimes(1);
      expect(handler).toHaveBeenCalledWith(expect.objectContaining({ ns: 'chat', type: 'MSG' }));
    });

    it('wildcard "*" handler receives all namespaces', async () => {
      const star = vi.fn();
      const chat = vi.fn();
      bus.subscribe('*', star);
      bus.subscribe('chat', chat);

      channel.onmessage!({ data: JSON.stringify(makeEnvelope('chat', 'MSG')) });
      channel.onmessage!({ data: JSON.stringify(makeEnvelope('file', 'META')) });
      await Promise.resolve();
      await Promise.resolve();

      expect(star).toHaveBeenCalledTimes(2);
      expect(chat).toHaveBeenCalledTimes(1);
    });

    it('subscribe returns an unsubscribe fn that removes the handler', async () => {
      const handler = vi.fn();
      const unsub = bus.subscribe('chat', handler);
      unsub();

      channel.onmessage!({ data: JSON.stringify(makeEnvelope('chat', 'MSG')) });
      await Promise.resolve();

      expect(handler).not.toHaveBeenCalled();
    });

    it('drops malformed envelopes from a malicious peer（嚴格型別驗證）', async () => {
      const handler = vi.fn();
      bus.subscribe('chat', handler);

      const malformed: unknown[] = [
        { ...makeEnvelope('chat'), ns: { evil: true } }, // ns 非字串
        { ...makeEnvelope('chat'), from: 12345 }, // from 非字串
        { ...makeEnvelope('chat'), v: 'x' }, // v 非數字
        { ...makeEnvelope('chat'), ts: 'now' }, // ts 非數字
        { ...makeEnvelope('chat'), type: '' }, // 空字串
        { ...makeEnvelope('chat'), payload: undefined }, // 無 payload
      ];
      for (const bad of malformed) {
        channel.onmessage!({ data: JSON.stringify(bad) });
      }
      await Promise.resolve();
      await Promise.resolve();

      expect(handler).not.toHaveBeenCalled();
    });

    it('drops envelopes using prototype-pollution ns/type（縱深防禦）', async () => {
      // 不訂 '*'：wildcard 會收到驗證失敗時發出的 system ERROR，會混淆斷言
      const protoHandler = vi.fn();
      const chatHandler = vi.fn();
      bus.subscribe('__proto__', protoHandler);
      bus.subscribe('chat', chatHandler);

      channel.onmessage!({ data: JSON.stringify({ ...makeEnvelope('__proto__', 'MSG') }) });
      channel.onmessage!({ data: JSON.stringify({ ...makeEnvelope('chat', 'constructor') }) });
      await Promise.resolve();
      await Promise.resolve();

      expect(protoHandler).not.toHaveBeenCalled();
      expect(chatHandler).not.toHaveBeenCalled();
      // 原型未被污染
      expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    });

    it('emits a system ERROR envelope when message fails to parse', async () => {
      const sysHandler = vi.fn();
      bus.subscribe('system', sysHandler);

      channel.onmessage!({ data: 'this-is-not-json' });
      await Promise.resolve();
      await Promise.resolve();

      expect(sysHandler).toHaveBeenCalled();
      const env = sysHandler.mock.calls[0][0] as P2PEnvelope;
      expect(env.type).toBe('ERROR');
      expect((env.payload as { type: string }).type).toBe('PARSE_ERROR');
    });

    it('drops oversized inbound messages and emits OVERSIZED_MESSAGE error (DoS guard)', async () => {
      const sysHandler = vi.fn();
      bus.subscribe('system', sysHandler);

      // 300 KB string — over the 256 KB cap
      const oversized = 'x'.repeat(300 * 1024);
      channel.onmessage!({ data: oversized });
      await Promise.resolve();
      await Promise.resolve();

      expect(sysHandler).toHaveBeenCalled();
      const env = sysHandler.mock.calls[0][0] as P2PEnvelope;
      expect(env.type).toBe('ERROR');
      expect((env.payload as { type: string }).type).toBe('OVERSIZED_MESSAGE');
    });

    it('emits INVALID_ENVELOPE error for envelope missing required fields', async () => {
      const sysHandler = vi.fn();
      bus.subscribe('system', sysHandler);

      channel.onmessage!({ data: JSON.stringify({ v: 1, type: 'MSG' /* missing ns/id/ts/from/payload */ }) });
      await Promise.resolve();
      await Promise.resolve();

      expect(sysHandler).toHaveBeenCalled();
      const env = sysHandler.mock.calls[0][0] as P2PEnvelope;
      expect(env.type).toBe('ERROR');
    });
  });

  describe('send', () => {
    it('sends serialized envelope immediately when channel is open and buffer is low', async () => {
      const env = makeEnvelope();
      await bus.send(env);

      expect(channel.send).toHaveBeenCalledTimes(1);
      expect(channel.send).toHaveBeenCalledWith(JSON.stringify(env));
    });

    it('rejects when the channel reference is null (after close)', async () => {
      bus.close();
      await expect(bus.send(makeEnvelope())).rejects.toThrow(/DataChannel not available/);
    });

    it('queues message when channel is not open (still resolves)', async () => {
      channel.readyState = 'connecting';
      const env = makeEnvelope();

      await expect(bus.send(env)).resolves.toBeUndefined();
      expect(channel.send).not.toHaveBeenCalled();

      // Simulate channel opening — onopen triggers queue flush
      channel.readyState = 'open';
      channel.onopen!();
      await Promise.resolve();
      await Promise.resolve();

      expect(channel.send).toHaveBeenCalledWith(JSON.stringify(env));
    });

    it('queues message when bufferedAmount exceeds the low-watermark', async () => {
      channel.bufferedAmount = 128 * 1024; // above 64KB threshold
      const env = makeEnvelope();

      await bus.send(env);
      expect(channel.send).not.toHaveBeenCalled();

      // Drain trigger
      channel.bufferedAmount = 0;
      channel.onbufferedamountlow!();
      await Promise.resolve();
      await Promise.resolve();

      expect(channel.send).toHaveBeenCalledWith(JSON.stringify(env));
    });

    it('rejects when underlying send throws', async () => {
      channel.send.mockImplementation(() => {
        throw new Error('boom');
      });
      await expect(bus.send(makeEnvelope())).rejects.toThrow('boom');
    });
  });

  describe('error/close hooks', () => {
    it('onerror emits a system CHANNEL_ERROR envelope to system handlers', async () => {
      const sysHandler = vi.fn();
      bus.subscribe('system', sysHandler);

      channel.onerror!(new Event('error'));
      await Promise.resolve();
      await Promise.resolve();

      const env = sysHandler.mock.calls[0]?.[0] as P2PEnvelope | undefined;
      expect(env?.type).toBe('ERROR');
      expect((env?.payload as { type: string }).type).toBe('CHANNEL_ERROR');
    });

    it('onclose does not throw', () => {
      expect(() => channel.onclose!()).not.toThrow();
    });
  });
});
