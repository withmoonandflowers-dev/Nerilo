/**
 * MessagePadding — Application-layer message padding
 *
 * Pads messages to fixed size intervals to prevent
 * traffic analysis based on ciphertext size correlation.
 *
 * Strategy:
 * - Messages are padded to the next multiple of BLOCK_SIZE
 * - A length prefix (4 bytes, big-endian) allows stripping padding
 * - Maximum message size is enforced
 * - All padded messages within the same block appear identical in size
 */

/** Padding block size in bytes (messages padded to multiples of this) */
const BLOCK_SIZE = 256;

/** Maximum padded message size in bytes */
const MAX_PADDED_SIZE = 65536; // 64KB

/** Length prefix size in bytes */
const LENGTH_PREFIX_SIZE = 4;

/**
 * Pad a message to the next multiple of BLOCK_SIZE.
 * Format: [4-byte big-endian length][original data][random padding]
 */
export function padMessage(data: Uint8Array): Uint8Array {
  const totalNeeded = LENGTH_PREFIX_SIZE + data.length;
  const paddedSize = Math.ceil(totalNeeded / BLOCK_SIZE) * BLOCK_SIZE;

  if (paddedSize > MAX_PADDED_SIZE) {
    throw new Error(
      `Message too large for padding: ${data.length} bytes (max ${MAX_PADDED_SIZE - LENGTH_PREFIX_SIZE})`
    );
  }

  const result = new Uint8Array(paddedSize);

  // Write length prefix (big-endian 4 bytes)
  const view = new DataView(result.buffer);
  view.setUint32(0, data.length, false);

  // Copy original data
  result.set(data, LENGTH_PREFIX_SIZE);

  // Fill padding with random bytes (indistinguishable from ciphertext)
  const paddingStart = LENGTH_PREFIX_SIZE + data.length;
  if (paddingStart < paddedSize) {
    const padding = crypto.getRandomValues(new Uint8Array(paddedSize - paddingStart));
    result.set(padding, paddingStart);
  }

  return result;
}

/**
 * Remove padding and extract the original message.
 */
export function unpadMessage(padded: Uint8Array): Uint8Array {
  if (padded.length < LENGTH_PREFIX_SIZE) {
    throw new Error('Padded message too short');
  }

  const view = new DataView(padded.buffer, padded.byteOffset, padded.byteLength);
  const originalLength = view.getUint32(0, false);

  if (originalLength > padded.length - LENGTH_PREFIX_SIZE) {
    throw new Error('Invalid length prefix in padded message');
  }

  return padded.slice(LENGTH_PREFIX_SIZE, LENGTH_PREFIX_SIZE + originalLength);
}

/**
 * Pad a string message (UTF-8 encoded).
 */
export function padString(message: string): Uint8Array {
  return padMessage(new TextEncoder().encode(message));
}

/**
 * Unpad and decode a string message.
 */
export function unpadString(padded: Uint8Array): string {
  return new TextDecoder().decode(unpadMessage(padded));
}

/**
 * Get the padded size for a given message length (for estimation).
 */
export function getPaddedSize(messageLength: number): number {
  const totalNeeded = LENGTH_PREFIX_SIZE + messageLength;
  return Math.ceil(totalNeeded / BLOCK_SIZE) * BLOCK_SIZE;
}

/**
 * Get the block size constant.
 */
export function getBlockSize(): number {
  return BLOCK_SIZE;
}
