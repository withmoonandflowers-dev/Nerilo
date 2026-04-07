/**
 * Message Codec
 *
 * Selects encoding based on payload size:
 * - payload < 256 bytes → JSON (avoids msgpack overhead for small messages)
 * - payload >= 256 bytes → MessagePack (compact binary encoding)
 *
 * Envelope header always uses JSON for debuggability.
 * Encoding is indicated via meta.encoding = 'json' | 'msgpack'
 */

import type { Envelope } from '../../types';

/** Threshold in bytes above which to use MessagePack */
const MSGPACK_THRESHOLD = 256;

/** Check if @msgpack/msgpack is available (lazy import) */
let msgpackEncode: ((obj: unknown) => Uint8Array) | null = null;
let msgpackDecode: ((buf: Uint8Array) => unknown) | null = null;

async function ensureMsgpack(): Promise<boolean> {
  if (msgpackEncode && msgpackDecode) return true;
  try {
    // @ts-expect-error optional peer dependency loaded at runtime
    const mod = await import('@msgpack/msgpack');
    msgpackEncode = mod.encode;
    msgpackDecode = mod.decode;
    return true;
  } catch {
    return false;
  }
}

export type MessageEncoding = 'json' | 'msgpack';

/**
 * Encode an envelope for transmission.
 * Returns a string (JSON) or ArrayBuffer (msgpack).
 */
export async function encodeEnvelope(
  envelope: Envelope
): Promise<{ data: string | ArrayBuffer; encoding: MessageEncoding }> {
  const jsonStr = JSON.stringify(envelope);
  const payloadSize = new Blob([jsonStr]).size;

  if (payloadSize >= MSGPACK_THRESHOLD && (await ensureMsgpack())) {
    const tagged = { ...envelope, meta: { ...envelope.meta, encoding: 'msgpack' as const } };
    const encoded = msgpackEncode!(tagged);
    return { data: encoded.buffer as ArrayBuffer, encoding: 'msgpack' };
  }

  // JSON path
  const tagged = { ...envelope, meta: { ...envelope.meta, encoding: 'json' as const } };
  return { data: JSON.stringify(tagged), encoding: 'json' };
}

/**
 * Decode a received message back into an Envelope.
 */
export async function decodeEnvelope(
  data: string | ArrayBuffer
): Promise<Envelope> {
  if (typeof data === 'string') {
    return JSON.parse(data) as Envelope;
  }

  // ArrayBuffer → msgpack
  if (await ensureMsgpack()) {
    const decoded = msgpackDecode!(new Uint8Array(data));
    return decoded as Envelope;
  }

  throw new Error('[MessageCodec] Cannot decode binary data: @msgpack/msgpack not available');
}

/**
 * Detect encoding from raw data without fully decoding.
 */
export function detectEncoding(data: string | ArrayBuffer): MessageEncoding {
  return typeof data === 'string' ? 'json' : 'msgpack';
}
