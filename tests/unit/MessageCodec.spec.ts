import { describe, it, expect } from 'vitest';
import {
  encodeEnvelope,
  decodeEnvelope,
  detectEncoding,
} from '../../src/core/transport/MessageCodec';
import type { Envelope } from '../../src/types';

function makeEnvelope(payloadSize = 10): Envelope {
  return {
    v: 1,
    ns: 'chat',
    type: 'MSG_SEND',
    id: 'test-id-123',
    ts: Date.now(),
    from: 'user-a',
    roomId: 'room-1',
    payload: { content: 'x'.repeat(payloadSize) },
  };
}

describe('MessageCodec', () => {
  describe('small payloads (< 256 bytes)', () => {
    it('should encode as JSON', async () => {
      const env = makeEnvelope(10);
      const result = await encodeEnvelope(env);

      expect(result.encoding).toBe('json');
      expect(typeof result.data).toBe('string');
    });

    it('should roundtrip correctly', async () => {
      const env = makeEnvelope(10);
      const { data } = await encodeEnvelope(env);
      const decoded = await decodeEnvelope(data);

      expect(decoded.id).toBe(env.id);
      expect(decoded.ns).toBe(env.ns);
      expect(decoded.type).toBe(env.type);
      expect(decoded.from).toBe(env.from);
    });

    it('should set meta.encoding to json', async () => {
      const env = makeEnvelope(10);
      const { data } = await encodeEnvelope(env);
      const decoded = await decodeEnvelope(data);

      expect(decoded.meta?.encoding).toBe('json');
    });
  });

  describe('large payloads (>= 256 bytes)', () => {
    it('should still roundtrip (may use json if msgpack unavailable)', async () => {
      const env = makeEnvelope(500);
      const { data, encoding } = await encodeEnvelope(env);

      // In test env without @msgpack/msgpack installed, falls back to JSON
      const decoded = await decodeEnvelope(data);
      expect(decoded.id).toBe(env.id);
      expect(decoded.from).toBe(env.from);
      // encoding is either json or msgpack depending on availability
      expect(['json', 'msgpack']).toContain(encoding);
    });
  });

  describe('detectEncoding()', () => {
    it('should detect string as json', () => {
      expect(detectEncoding('{"test":true}')).toBe('json');
    });

    it('should detect ArrayBuffer as msgpack', () => {
      expect(detectEncoding(new ArrayBuffer(10))).toBe('msgpack');
    });
  });

  describe('decodeEnvelope()', () => {
    it('should decode valid JSON string', async () => {
      const json = JSON.stringify({
        v: 1,
        ns: 'test',
        type: 'TEST',
        id: 'x',
        ts: 100,
        from: 'a',
        roomId: 'r',
        payload: {},
      });

      const decoded = await decodeEnvelope(json);
      expect(decoded.ns).toBe('test');
    });

    it('should throw on invalid JSON string', async () => {
      await expect(decodeEnvelope('not-json')).rejects.toThrow();
    });
  });
});
