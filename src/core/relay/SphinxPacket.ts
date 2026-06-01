/**
 * SphinxPacket — Simplified onion routing packet format (Sphinx-Lite)
 *
 * Provides sender anonymity through layered encryption:
 * - Each relay hop can only see the next hop
 * - Relay nodes cannot read content or identify sender/receiver
 * - Fixed-size packets prevent size-based traffic analysis
 *
 * Simplifications vs full Sphinx:
 * - Uses SubtleCrypto ECDH + AES-256-GCM (browser-native)
 * - 2-3 hops instead of Nym's 5
 * - No SURBs (Single Use Reply Blocks) in this version
 *
 * Packet structure per hop:
 *   [ephemeral ECDH pubkey (65B)] [encrypted routing info] [MAC]
 *   → decrypted routing info reveals: { nextHop, nextHeader, delayHint }
 */

import type { SphinxHeader, RoutingInfo, SphinxPacket as SphinxPacketType, RouteHop } from './types';
import { padMessage, unpadMessage } from './MessagePadding';

/** Maximum hops supported */
const MAX_HOPS = 4;
/** Fixed packet payload size in bytes */
const PACKET_PAYLOAD_SIZE = 4096;

// ── Helper Functions ─────────────────────────────────────────────────────────

function bufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function base64ToBuffer(base64: string): ArrayBuffer {
  let binary: string;
  try {
    binary = atob(base64);
  } catch {
    throw new Error('Invalid base64 input');
  }
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

async function generateEphemeralKeyPair(): Promise<CryptoKeyPair> {
  return crypto.subtle.generateKey(
    { name: 'ECDH', namedCurve: 'P-256' },
    true,
    ['deriveKey', 'deriveBits']
  );
}

async function deriveAESKey(
  privateKey: CryptoKey,
  publicKey: CryptoKey
): Promise<CryptoKey> {
  return crypto.subtle.deriveKey(
    { name: 'ECDH', public: publicKey },
    privateKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
}

async function exportPublicKey(key: CryptoKey): Promise<string> {
  const raw = await crypto.subtle.exportKey('raw', key);
  return bufferToBase64(raw);
}

async function importPublicKey(base64: string): Promise<CryptoKey> {
  const raw = base64ToBuffer(base64);
  return crypto.subtle.importKey(
    'raw',
    raw,
    { name: 'ECDH', namedCurve: 'P-256' },
    true,
    []
  );
}

async function aesGcmEncrypt(
  key: CryptoKey,
  plaintext: Uint8Array
): Promise<{ ciphertext: string; iv: string; mac: string }> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, tagLength: 128 },
    key,
    plaintext as unknown as ArrayBuffer
  );
  // AES-GCM appends the tag to the ciphertext
  const encBytes = new Uint8Array(encrypted);
  const ciphertextBytes = encBytes.slice(0, encBytes.length - 16);
  const macBytes = encBytes.slice(encBytes.length - 16);

  return {
    ciphertext: bufferToBase64(ciphertextBytes.buffer),
    iv: bufferToBase64(iv.buffer),
    mac: bufferToBase64(macBytes.buffer),
  };
}

async function aesGcmDecrypt(
  key: CryptoKey,
  ciphertextB64: string,
  ivB64: string,
  macB64: string
): Promise<Uint8Array> {
  const ciphertext = new Uint8Array(base64ToBuffer(ciphertextB64));
  const iv = new Uint8Array(base64ToBuffer(ivB64));
  const mac = new Uint8Array(base64ToBuffer(macB64));

  // Reassemble ciphertext + tag
  const combined = new Uint8Array(ciphertext.length + mac.length);
  combined.set(ciphertext);
  combined.set(mac, ciphertext.length);

  const decrypted = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv, tagLength: 128 },
    key,
    combined
  );
  return new Uint8Array(decrypted);
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Create a Sphinx-Lite packet with layered encryption.
 *
 * @param payload The plaintext payload to deliver
 * @param route Ordered list of relay hops (each with nodeId and ECDH public key)
 * @param destinationPubKey Final destination's ECDH public key (for payload encryption)
 * @returns The constructed Sphinx packet
 */
export async function createSphinxPacket(
  payload: Uint8Array,
  route: RouteHop[],
  destinationPubKey: string
): Promise<SphinxPacketType> {
  if (route.length === 0) {
    throw new Error('Route must have at least one hop');
  }
  if (route.length > MAX_HOPS) {
    throw new Error(`Route exceeds maximum ${MAX_HOPS} hops`);
  }

  // Pad payload to fixed size
  const paddedPayload = padMessage(payload);
  if (paddedPayload.length > PACKET_PAYLOAD_SIZE) {
    throw new Error(`Padded payload exceeds ${PACKET_PAYLOAD_SIZE} bytes`);
  }
  // Pad to exactly PACKET_PAYLOAD_SIZE
  const fixedPayload = new Uint8Array(PACKET_PAYLOAD_SIZE);
  fixedPayload.set(paddedPayload);

  // Build layers from inside out (last hop first)
  let currentPayload = fixedPayload;
  let currentHeader: SphinxHeader | null = null;

  // Encrypt payload for the final destination
  const destKeyPair = await generateEphemeralKeyPair();
  const destPubKey = await importPublicKey(destinationPubKey);
  const destSharedKey = await deriveAESKey(destKeyPair.privateKey, destPubKey);
  const destEphPub = await exportPublicKey(destKeyPair.publicKey);

  const encPayload = await aesGcmEncrypt(destSharedKey, currentPayload);

  // Combine encrypted payload parts into a single base64 string
  currentPayload = new TextEncoder().encode(
    JSON.stringify({ c: encPayload.ciphertext, i: encPayload.iv, m: encPayload.mac, e: destEphPub })
  );

  // Build headers from last hop to first hop
  for (let i = route.length - 1; i >= 0; i--) {
    const hop = route[i];
    const ephKeyPair = await generateEphemeralKeyPair();
    const hopPubKey = await importPublicKey(hop.ephemeralPubKey);
    const sharedKey = await deriveAESKey(ephKeyPair.privateKey, hopPubKey);

    // Routing info for this hop
    const routingInfo: RoutingInfo = {
      nextHop: i < route.length - 1 ? route[i + 1].nodeId : '', // empty = final destination
      nextHeader: currentHeader ? JSON.stringify(currentHeader) : '',
      delayHint: 0,
    };

    const routingInfoBytes = new TextEncoder().encode(JSON.stringify(routingInfo));
    const encRouting = await aesGcmEncrypt(sharedKey, routingInfoBytes);

    currentHeader = {
      version: 1,
      ephemeralKey: await exportPublicKey(ephKeyPair.publicKey),
      routingInfo: encRouting.ciphertext + '.' + encRouting.iv,
      mac: encRouting.mac,
    };
  }

  return {
    header: currentHeader!,
    payload: bufferToBase64(currentPayload.buffer),
    packetSize: PACKET_PAYLOAD_SIZE,
  };
}

/**
 * Process (peel) a Sphinx packet at a relay node.
 *
 * @param packet The received Sphinx packet
 * @param localPrivateKey This node's ECDH private key
 * @returns The peeled routing info and the packet to forward (or the final payload)
 */
export async function peelSphinxLayer(
  packet: SphinxPacketType,
  localPrivateKey: CryptoKey
): Promise<{
  routingInfo: RoutingInfo;
  /** If nextHop is empty, this is the final encrypted payload */
  forwardPacket: SphinxPacketType | null;
  /** Raw payload (only at final destination, after destination decrypts) */
  payload: string;
}> {
  const header = packet.header;

  // Import the ephemeral public key from the header
  const ephPubKey = await importPublicKey(header.ephemeralKey);

  // Derive shared key
  const sharedKey = await deriveAESKey(localPrivateKey, ephPubKey);

  // Decrypt routing info
  const [ciphertext, iv] = header.routingInfo.split('.');
  const routingInfoBytes = await aesGcmDecrypt(sharedKey, ciphertext, iv, header.mac);
  const routingInfo: RoutingInfo = JSON.parse(new TextDecoder().decode(routingInfoBytes));

  if (routingInfo.nextHop === '') {
    // This is the last relay hop — payload is the encrypted message for destination
    return {
      routingInfo,
      forwardPacket: null,
      payload: packet.payload,
    };
  }

  // Parse next header
  const nextHeader: SphinxHeader = JSON.parse(routingInfo.nextHeader);

  return {
    routingInfo,
    forwardPacket: {
      header: nextHeader,
      payload: packet.payload,
      packetSize: packet.packetSize,
    },
    payload: '',
  };
}

/**
 * Decrypt the final payload at the destination.
 *
 * @param encryptedPayloadB64 The base64 encoded encrypted payload
 * @param localPrivateKey Destination's ECDH private key
 * @returns Decrypted plaintext payload
 */
export async function decryptFinalPayload(
  encryptedPayloadB64: string,
  localPrivateKey: CryptoKey
): Promise<Uint8Array> {
  const encPayloadStr = new TextDecoder().decode(
    new Uint8Array(base64ToBuffer(encryptedPayloadB64))
  );
  const { c, i, m, e } = JSON.parse(encPayloadStr);

  // Import sender's ephemeral public key
  const senderEphPub = await importPublicKey(e);
  const sharedKey = await deriveAESKey(localPrivateKey, senderEphPub);

  // Decrypt payload
  const paddedPayload = await aesGcmDecrypt(sharedKey, c, i, m);

  // Remove padding
  return unpadMessage(paddedPayload);
}

/**
 * Get the maximum number of hops supported.
 */
export function getMaxHops(): number {
  return MAX_HOPS;
}

/**
 * Get the fixed packet payload size.
 */
export function getPacketPayloadSize(): number {
  return PACKET_PAYLOAD_SIZE;
}
