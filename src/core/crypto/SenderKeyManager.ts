/**
 * Sender Keys E2E Encryption Manager
 *
 * Each user generates an AES-256-GCM sender key.
 * The sender key is encrypted per-member via ECDH and distributed.
 * Key rotation occurs when members join or leave.
 *
 * Uses browser-native SubtleCrypto exclusively.
 */

import {
  deriveSharedSecret,
  encryptForPeer,
  decryptFromPeer,
} from './ECDHKeyExchange';

export interface EncryptedPayload {
  /** Encrypted message content */
  ciphertext: string; // Base64
  /** Initialization vector (12 bytes, Base64) */
  iv: string; // Base64
  /** Epoch of the sender key used */
  senderKeyEpoch: number;
  /** Monotonic counter within epoch for replay protection */
  seq: number;
}

export interface SenderKeyDistribution {
  /** Sender's userId */
  senderId: string;
  /** Current epoch number */
  epoch: number;
  /** Map: recipientId → { encryptedKey (Base64), iv (Base64) } */
  encryptedKeys: Record<string, { encryptedKey: string; iv: string }>;
}

interface PeerPublicKey {
  peerId: string;
  publicKey: CryptoKey;
}

export class SenderKeyManager {
  private currentSenderKey: CryptoKey | null = null;
  private currentEpoch = 0;
  /** Received sender keys from other peers: peerId → { epoch, key } */
  private peerSenderKeys = new Map<string, { epoch: number; key: CryptoKey }>();
  /** Previous epoch sender keys (for in-flight messages): peerId → { epoch, key } */
  private previousPeerKeys = new Map<string, { epoch: number; key: CryptoKey }>();
  /** Local ECDH key pair for key exchange */
  private ecdhKeyPair: CryptoKeyPair | null = null;

  // ── Auto-rotation state ──────────────────────────────────────────────────
  /** Messages encrypted since last key rotation */
  private messagesSinceRotation = 0;
  /** Timestamp of last key rotation */
  private lastRotationAt = 0;
  /** Auto-rotation threshold: rotate after this many messages */
  private rotationMessageThreshold = 100;
  /** Auto-rotation threshold: rotate after this many ms */
  private rotationTimeThresholdMs = 3600_000; // 1 hour
  /** Callback to distribute new key after rotation */
  private onRotationCallback: ((dist: SenderKeyDistribution) => Promise<void>) | null = null;
  /** Peer public keys cache for redistribution after rotation */
  private cachedMembers: PeerPublicKey[] = [];

  // ── Replay protection ──────────────────────────────────────────────────
  /** Monotonic sequence counter per epoch (reset on key rotation) */
  private seqCounter = 0;
  /** Per-peer per-epoch last-seen sequence number: "peerId:epoch" → lastSeq */
  private peerSeqCounters = new Map<string, number>();

  constructor(private readonly localUserId: string) {}

  /**
   * Generate (or regenerate) the local ECDH key pair for key exchange.
   */
  async initKeyPair(): Promise<CryptoKey> {
    this.ecdhKeyPair = await crypto.subtle.generateKey(
      { name: 'ECDH', namedCurve: 'P-256' },
      false,
      ['deriveKey', 'deriveBits']
    );
    return this.ecdhKeyPair.publicKey;
  }

  /**
   * Get the local ECDH public key for sharing with peers.
   */
  getECDHPublicKey(): CryptoKey | null {
    return this.ecdhKeyPair?.publicKey ?? null;
  }

  /**
   * Generate a new AES-256-GCM sender key (for local use).
   */
  async generateSenderKey(): Promise<CryptoKey> {
    this.currentSenderKey = await crypto.subtle.generateKey(
      { name: 'AES-GCM', length: 256 },
      true, // extractable so we can export and encrypt for peers
      ['encrypt', 'decrypt']
    );
    this.currentEpoch++;
    this.seqCounter = 0; // Reset seq on new epoch
    return this.currentSenderKey;
  }

  /**
   * Distribute the current sender key to all members.
   * Encrypts the sender key for each peer using ECDH shared secret.
   */
  async distributeSenderKey(
    members: PeerPublicKey[]
  ): Promise<SenderKeyDistribution> {
    if (!this.currentSenderKey || !this.ecdhKeyPair) {
      throw new Error('Sender key or ECDH key pair not initialized');
    }

    // Export sender key as raw bytes
    const rawKey = await crypto.subtle.exportKey('raw', this.currentSenderKey);

    const encryptedKeys: Record<string, { encryptedKey: string; iv: string }> = {};

    for (const member of members) {
      // Derive shared secret with this peer
      const sharedSecret = await deriveSharedSecret(
        this.ecdhKeyPair.privateKey,
        member.publicKey
      );

      // Encrypt the sender key for this peer
      const { ciphertext, iv } = await encryptForPeer(rawKey, sharedSecret);

      encryptedKeys[member.peerId] = {
        encryptedKey: bufferToBase64(ciphertext),
        iv: bufferToBase64(iv.buffer as ArrayBuffer),
      };
    }

    return {
      senderId: this.localUserId,
      epoch: this.currentEpoch,
      encryptedKeys,
    };
  }

  /**
   * Receive and decrypt a sender key from another peer.
   */
  async receiveSenderKey(
    distribution: SenderKeyDistribution,
    senderECDHPublicKey: CryptoKey
  ): Promise<CryptoKey> {
    if (!this.ecdhKeyPair) {
      throw new Error('ECDH key pair not initialized');
    }

    const myEntry = distribution.encryptedKeys[this.localUserId];
    if (!myEntry) {
      throw new Error('No encrypted key for this user in distribution');
    }

    // Derive shared secret
    const sharedSecret = await deriveSharedSecret(
      this.ecdhKeyPair.privateKey,
      senderECDHPublicKey
    );

    // Decrypt the sender key
    const rawKey = await decryptFromPeer(
      base64ToBuffer(myEntry.encryptedKey),
      new Uint8Array(base64ToBuffer(myEntry.iv)),
      sharedSecret
    );

    // Import as AES-GCM key
    const senderKey = await crypto.subtle.importKey(
      'raw',
      rawKey,
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt', 'decrypt']
    );

    // Store, preserving previous key for in-flight messages
    const existing = this.peerSenderKeys.get(distribution.senderId);
    if (existing) {
      this.previousPeerKeys.set(distribution.senderId, existing);
    }
    // No need to reset replay counter — it's scoped per (senderId:epoch)
    // Old epoch counters will be cleaned up naturally
    this.peerSenderKeys.set(distribution.senderId, {
      epoch: distribution.epoch,
      key: senderKey,
    });

    return senderKey;
  }

  // ── Auto-Rotation API ───────────────────────────────────────────────────

  /**
   * Configure auto-rotation parameters.
   * @param messageThreshold Rotate after this many messages (default: 100)
   * @param timeThresholdMs Rotate after this many ms (default: 1 hour)
   */
  configureAutoRotation(messageThreshold: number, timeThresholdMs: number): void {
    this.rotationMessageThreshold = messageThreshold;
    this.rotationTimeThresholdMs = timeThresholdMs;
  }

  /**
   * Set callback invoked when auto-rotation triggers key redistribution.
   * The callback receives the new SenderKeyDistribution to broadcast.
   */
  onAutoRotation(callback: (dist: SenderKeyDistribution) => Promise<void>): void {
    this.onRotationCallback = callback;
  }

  /**
   * Update the cached member list for auto-rotation redistribution.
   * Call this whenever members join or leave.
   */
  updateMembers(members: PeerPublicKey[]): void {
    this.cachedMembers = [...members];
  }

  /**
   * Check if auto-rotation is needed and perform it if so.
   * Returns the new distribution if rotation occurred, null otherwise.
   */
  async checkAutoRotation(): Promise<SenderKeyDistribution | null> {
    if (!this.currentSenderKey || !this.ecdhKeyPair) return null;

    const now = Date.now();
    const messageThresholdReached =
      this.messagesSinceRotation >= this.rotationMessageThreshold;
    const timeThresholdReached =
      this.lastRotationAt > 0 &&
      now - this.lastRotationAt >= this.rotationTimeThresholdMs;

    if (!messageThresholdReached && !timeThresholdReached) return null;

    // Perform rotation
    await this.generateSenderKey();
    this.messagesSinceRotation = 0;
    this.lastRotationAt = now;

    if (this.cachedMembers.length === 0) return null;

    const distribution = await this.distributeSenderKey(this.cachedMembers);

    // Notify via callback
    if (this.onRotationCallback) {
      try {
        await this.onRotationCallback(distribution);
      } catch {
        // Best-effort notification
      }
    }

    return distribution;
  }

  /**
   * Force an immediate key rotation (e.g., when a member leaves).
   * Returns the new distribution for remaining members.
   */
  async forceRotation(
    remainingMembers?: PeerPublicKey[]
  ): Promise<SenderKeyDistribution | null> {
    if (!this.ecdhKeyPair) return null;

    const members = remainingMembers ?? this.cachedMembers;
    await this.generateSenderKey();
    this.messagesSinceRotation = 0;
    this.lastRotationAt = Date.now();

    if (members.length === 0) return null;

    if (remainingMembers) {
      this.cachedMembers = [...remainingMembers];
    }

    return this.distributeSenderKey(members);
  }

  /**
   * Encrypt a message using our sender key.
   * Tracks message count for auto-rotation.
   */
  async encryptMessage(plaintext: string): Promise<EncryptedPayload> {
    if (!this.currentSenderKey) {
      throw new Error('Sender key not initialized');
    }

    const iv = crypto.getRandomValues(new Uint8Array(12));
    const encoded = new TextEncoder().encode(plaintext);

    const ciphertext = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv },
      this.currentSenderKey,
      encoded
    );

    this.messagesSinceRotation++;
    const seq = this.seqCounter++;

    return {
      ciphertext: bufferToBase64(ciphertext),
      iv: bufferToBase64(iv.buffer as ArrayBuffer),
      senderKeyEpoch: this.currentEpoch,
      seq,
    };
  }

  /**
   * Decrypt a message from a peer using their sender key.
   * Validates seq counter to prevent replay attacks.
   */
  async decryptMessage(
    payload: EncryptedPayload,
    senderId: string
  ): Promise<string> {
    // Replay protection: verify seq is strictly increasing per sender per epoch
    if (typeof payload.seq !== 'number') {
      throw new Error(`Missing seq field from ${senderId} — potential replay attack`);
    }
    const seqKey = `${senderId}:${payload.senderKeyEpoch}`;
    const lastSeq = this.peerSeqCounters.get(seqKey) ?? -1;
    if (payload.seq <= lastSeq) {
      throw new Error(
        `Replay detected from ${senderId}: seq ${payload.seq} <= last ${lastSeq}`
      );
    }
    this.peerSeqCounters.set(seqKey, payload.seq);

    // Try current key first
    let entry = this.peerSenderKeys.get(senderId);

    // If epoch doesn't match, try previous key (in-flight message)
    if (entry && entry.epoch !== payload.senderKeyEpoch) {
      const prev = this.previousPeerKeys.get(senderId);
      if (prev && prev.epoch === payload.senderKeyEpoch) {
        entry = prev;
      }
    }

    if (!entry) {
      throw new Error(`No sender key for peer ${senderId} at epoch ${payload.senderKeyEpoch}`);
    }

    const ciphertext = base64ToBuffer(payload.ciphertext);
    const iv = new Uint8Array(base64ToBuffer(payload.iv));

    const decrypted = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv },
      entry.key,
      ciphertext
    );

    return new TextDecoder().decode(decrypted);
  }

  /** Current sender key epoch */
  get epoch(): number {
    return this.currentEpoch;
  }

  /** Check if we have a sender key for a peer */
  hasPeerKey(peerId: string): boolean {
    return this.peerSenderKeys.has(peerId);
  }

  /** Remove a peer's sender key (when they leave) */
  removePeerKey(peerId: string): void {
    this.peerSenderKeys.delete(peerId);
    this.previousPeerKeys.delete(peerId);
  }

  /** Get messages since last rotation (for monitoring) */
  getMessagesSinceRotation(): number {
    return this.messagesSinceRotation;
  }

  /** Clear all keys */
  destroy(): void {
    this.currentSenderKey = null;
    this.ecdhKeyPair = null;
    this.peerSenderKeys.clear();
    this.previousPeerKeys.clear();
    this.cachedMembers = [];
    this.onRotationCallback = null;
    this.messagesSinceRotation = 0;
    this.lastRotationAt = 0;
    this.seqCounter = 0;
    this.peerSeqCounters.clear();
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function bufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
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
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes.buffer;
}
