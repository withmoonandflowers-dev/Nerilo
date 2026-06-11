/**
 * TreeKEMManager — Binary-Tree Ratchet for Scalable Group Key Distribution
 *
 * Solves the O(N) ECDH bottleneck in SenderKeyManager for large groups (50+).
 *
 * Core idea (simplified MLS/TreeKEM):
 *   - Members are leaves in a left-balanced binary tree
 *   - Each node holds a key pair; the root node's secret = group secret
 *   - To update: a member generates a new leaf key, recomputes path to root,
 *     then encrypts each path secret to the co-path node's public key
 *   - Recipients only need O(log N) decryptions to derive the new group key
 *
 * Key distribution cost:
 *   - SenderKey:  O(N) ECDH operations per rotation
 *   - TreeKEM:    O(log N) ECDH operations per rotation
 *
 * Limitations of this implementation:
 *   - Uses ECDH P-256 + HKDF (same primitives as SenderKeyManager)
 *   - Tree is rebuilt on member add/remove (vs. MLS blank nodes)
 *   - No out-of-order message handling (assumes ordered delivery)
 *
 * Integrates with the existing EncryptedPayload / SenderKeyDistribution types.
 */

import { logger } from '../../utils/logger';
import {
  deriveSharedSecret,
  encryptForPeer,
  decryptFromPeer,
} from './ECDHKeyExchange';
import type { EncryptedPayload } from './SenderKeyManager';

// ── Tree Node Types ─────────────────────────────────────────────────────────

export interface TreeNode {
  /** Node index in the binary tree (0 = root, left-balanced) */
  index: number;
  /** ECDH public key for this node (null = blank node) */
  publicKey: CryptoKey | null;
  /** ECDH private key (only set for nodes on our direct path) */
  privateKey: CryptoKey | null;
  /** Derived symmetric secret at this node (HKDF from ECDH agreement) */
  secret: CryptoKey | null;
  /** Leaf member ID (only for leaf nodes) */
  memberId: string | null;
}

/** Encrypted path secret for a co-path recipient */
export interface TreeKEMCiphertext {
  /** Node index this ciphertext is for */
  nodeIndex: number;
  /** Encrypted node secret (Base64) */
  ciphertext: string;
  /** IV for decryption (Base64) */
  iv: string;
}

/** Complete TreeKEM update message broadcast after a key rotation */
export interface TreeKEMUpdate {
  /** Who initiated the update */
  senderId: string;
  /** New epoch number */
  epoch: number;
  /** Public keys along the direct path (root to leaf) */
  pathPublicKeys: Array<{ nodeIndex: number; publicKeyRaw: string }>;
  /** Encrypted secrets for each co-path node */
  ciphertexts: TreeKEMCiphertext[];
}

// ── TreeKEM Manager ─────────────────────────────────────────────────────────

export class TreeKEMManager {
  private tree: TreeNode[] = [];
  private memberIds: string[] = [];
  private leafIndex = -1; // Our position in the tree
  private currentEpoch = 0;
  private groupSecret: CryptoKey | null = null;
  private ecdhKeyPair: CryptoKeyPair | null = null;
  private messagesSinceRotation = 0;
  private lastRotationAt = 0;
  private rotationMessageThreshold = 100;
  private rotationTimeThresholdMs = 3600_000;
  private onRotationCallback: ((update: TreeKEMUpdate) => Promise<void>) | null = null;

  constructor(private readonly localUserId: string) {}

  // ── Initialization ──────────────────────────────────────────────────────

  /**
   * Initialize the local ECDH key pair.
   */
  async initKeyPair(): Promise<CryptoKey> {
    this.ecdhKeyPair = await crypto.subtle.generateKey(
      { name: 'ECDH', namedCurve: 'P-256' },
      true, // exportable for tree sharing
      ['deriveKey', 'deriveBits']
    );
    return this.ecdhKeyPair.publicKey;
  }

  getECDHPublicKey(): CryptoKey | null {
    return this.ecdhKeyPair?.publicKey ?? null;
  }

  /**
   * Build the initial tree from a list of members and their public keys.
   * The first call to this sets up the complete tree structure.
   */
  async buildTree(
    members: Array<{ peerId: string; publicKey: CryptoKey }>
  ): Promise<TreeKEMUpdate> {
    if (!this.ecdhKeyPair) {
      throw new Error('ECDH key pair not initialized');
    }

    // Include ourselves
    const allMembers = [
      { peerId: this.localUserId, publicKey: this.ecdhKeyPair.publicKey },
      ...members.filter(m => m.peerId !== this.localUserId),
    ];

    this.memberIds = allMembers.map(m => m.peerId);
    const leafCount = allMembers.length;
    const treeSize = TreeKEMManager.treeNodeCount(leafCount);

    // Initialize tree nodes
    this.tree = Array.from({ length: treeSize }, (_, i) => ({
      index: i,
      publicKey: null,
      privateKey: null,
      secret: null,
      memberId: null,
    }));

    // Assign leaves
    for (let i = 0; i < leafCount; i++) {
      const leafIdx = TreeKEMManager.leafNodeIndex(i, leafCount);
      const member = allMembers[i]!;
      this.tree[leafIdx]!.publicKey = member.publicKey;
      this.tree[leafIdx]!.memberId = member.peerId;

      if (member.peerId === this.localUserId) {
        this.leafIndex = leafIdx;
        this.tree[leafIdx]!.privateKey = this.ecdhKeyPair.privateKey;
      }
    }

    // Generate our path and compute group secret
    return this.updatePath();
  }

  /**
   * Process a TreeKEM update from another member.
   * Decrypts the co-path secret relevant to us, then derives group key.
   */
  async processUpdate(update: TreeKEMUpdate): Promise<void> {
    if (!this.ecdhKeyPair) {
      throw new Error('ECDH key pair not initialized');
    }

    this.currentEpoch = update.epoch;

    // Apply public keys from the update
    for (const pk of update.pathPublicKeys) {
      if (this.tree[pk.nodeIndex]) {
        this.tree[pk.nodeIndex]!.publicKey = await importPublicKey(pk.publicKeyRaw);
        // Clear our private key for this node (sender regenerated it)
        this.tree[pk.nodeIndex]!.privateKey = null;
        this.tree[pk.nodeIndex]!.secret = null;
      }
    }

    // Find which ciphertext is for us (our co-path node)
    const ourCoPath = this.getCoPath(this.leafIndex);
    let decryptedNodeIndex = -1;
    let decryptedSecret: ArrayBuffer | null = null;

    for (const ct of update.ciphertexts) {
      if (ourCoPath.includes(ct.nodeIndex)) {
        // We can decrypt this one using our private key at this co-path position
        const ourNode = this.findOurNodeForCoPath(ct.nodeIndex);
        if (ourNode !== -1 && this.tree[ourNode]?.privateKey) {
          const senderPubKey = this.findParentPublicKey(ct.nodeIndex, update);
          if (senderPubKey) {
            const sharedSecret = await deriveSharedSecret(
              this.tree[ourNode]!.privateKey!,
              senderPubKey
            );
            decryptedSecret = await decryptFromPeer(
              base64ToBuffer(ct.ciphertext),
              new Uint8Array(base64ToBuffer(ct.iv)),
              sharedSecret
            );
            decryptedNodeIndex = this.getParent(ct.nodeIndex);
            break;
          }
        }
      }
    }

    if (decryptedSecret === null) {
      logger.warn('[TreeKEM] Could not decrypt any co-path secret');
      return;
    }

    // Derive secrets up to root from the decrypted secret
    await this.derivePathFromSecret(decryptedNodeIndex, decryptedSecret);

    // Group secret = root node's secret
    this.groupSecret = this.tree[0]?.secret ?? null;
    this.messagesSinceRotation = 0;
    this.lastRotationAt = Date.now();
  }

  // ── Key Rotation ────────────────────────────────────────────────────────

  /**
   * Update our leaf key and recompute the path to root.
   * This is the O(log N) operation that replaces O(N) SenderKey distribution.
   */
  async updatePath(): Promise<TreeKEMUpdate> {
    if (!this.ecdhKeyPair) {
      throw new Error('ECDH key pair not initialized');
    }

    // Generate new leaf key pair
    const newKeyPair = await crypto.subtle.generateKey(
      { name: 'ECDH', namedCurve: 'P-256' },
      true,
      ['deriveKey', 'deriveBits']
    );
    this.ecdhKeyPair = newKeyPair;
    this.tree[this.leafIndex]!.publicKey = newKeyPair.publicKey;
    this.tree[this.leafIndex]!.privateKey = newKeyPair.privateKey;

    this.currentEpoch++;

    // Generate new key pairs along our direct path to root
    const directPath = this.getDirectPath(this.leafIndex);
    const pathKeys: CryptoKeyPair[] = [];
    const pathPublicKeys: Array<{ nodeIndex: number; publicKeyRaw: string }> = [];

    // Include leaf public key
    pathPublicKeys.push({
      nodeIndex: this.leafIndex,
      publicKeyRaw: await exportPublicKey(newKeyPair.publicKey),
    });

    for (const nodeIdx of directPath) {
      const kp = await crypto.subtle.generateKey(
        { name: 'ECDH', namedCurve: 'P-256' },
        true,
        ['deriveKey', 'deriveBits']
      );
      pathKeys.push(kp);
      this.tree[nodeIdx]!.publicKey = kp.publicKey;
      this.tree[nodeIdx]!.privateKey = kp.privateKey;

      pathPublicKeys.push({
        nodeIndex: nodeIdx,
        publicKeyRaw: await exportPublicKey(kp.publicKey),
      });
    }

    // Encrypt path secrets for co-path nodes
    const coPath = this.getCoPath(this.leafIndex);
    const ciphertexts: TreeKEMCiphertext[] = [];

    for (let i = 0; i < coPath.length && i < pathKeys.length; i++) {
      const coPathNode = coPath[i]!;
      const pathKey = pathKeys[i]!;

      // Get co-path node's public key (the sibling subtree's key)
      const coPathPubKey = this.tree[coPathNode]?.publicKey;
      if (!coPathPubKey) continue;

      // Encrypt the path node's private key for the co-path node
      // In real MLS, this would be a path secret; here we send the ECDH private key
      const nodeSecret = await crypto.subtle.exportKey('pkcs8', pathKey.privateKey);

      const sharedSecret = await deriveSharedSecret(pathKey.privateKey, coPathPubKey);
      const { ciphertext, iv } = await encryptForPeer(nodeSecret, sharedSecret);

      ciphertexts.push({
        nodeIndex: coPathNode,
        ciphertext: bufferToBase64(ciphertext),
        iv: bufferToBase64(iv.buffer as ArrayBuffer),
      });
    }

    // Derive group secret from root
    if (directPath.length > 0) {
      const rootKey = pathKeys[pathKeys.length - 1];
      if (rootKey) {
        this.groupSecret = await deriveGroupKey(rootKey.privateKey, rootKey.publicKey);
        this.tree[0]!.secret = this.groupSecret;
      }
    } else {
      // Single member — use own key
      this.groupSecret = await deriveGroupKey(newKeyPair.privateKey, newKeyPair.publicKey);
      this.tree[this.leafIndex]!.secret = this.groupSecret;
    }

    this.messagesSinceRotation = 0;
    this.lastRotationAt = Date.now();

    const update: TreeKEMUpdate = {
      senderId: this.localUserId,
      epoch: this.currentEpoch,
      pathPublicKeys,
      ciphertexts,
    };

    if (this.onRotationCallback) {
      try {
        await this.onRotationCallback(update);
      } catch {
        // best effort
      }
    }

    return update;
  }

  /**
   * Force rotation (e.g., member departure).
   */
  async forceRotation(): Promise<TreeKEMUpdate> {
    return this.updatePath();
  }

  /**
   * Check auto-rotation thresholds.
   */
  async checkAutoRotation(): Promise<TreeKEMUpdate | null> {
    if (!this.groupSecret) return null;

    const now = Date.now();
    const messageThresholdReached = this.messagesSinceRotation >= this.rotationMessageThreshold;
    const timeThresholdReached =
      this.lastRotationAt > 0 && now - this.lastRotationAt >= this.rotationTimeThresholdMs;

    if (!messageThresholdReached && !timeThresholdReached) return null;
    return this.updatePath();
  }

  // ── Message Encryption/Decryption ─────────────────────────────────────

  /**
   * Encrypt a message using the current group secret.
   */
  async encryptMessage(plaintext: string): Promise<EncryptedPayload> {
    if (!this.groupSecret) {
      throw new Error('Group secret not initialized');
    }

    const iv = crypto.getRandomValues(new Uint8Array(12));
    const encoded = new TextEncoder().encode(plaintext);

    const ciphertext = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv },
      this.groupSecret,
      encoded
    );

    const seq = this.messagesSinceRotation++;

    return {
      ciphertext: bufferToBase64(ciphertext),
      iv: bufferToBase64(iv.buffer as ArrayBuffer),
      senderKeyEpoch: this.currentEpoch,
      seq,
    };
  }

  /**
   * Decrypt a message using the group secret.
   */
  async decryptMessage(payload: EncryptedPayload): Promise<string> {
    if (!this.groupSecret) {
      throw new Error('Group secret not initialized');
    }

    // Note: In production, we'd track previous epoch group secrets for
    // in-flight messages, similar to SenderKeyManager's previousPeerKeys.
    const ciphertext = base64ToBuffer(payload.ciphertext);
    const iv = new Uint8Array(base64ToBuffer(payload.iv));

    const decrypted = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv },
      this.groupSecret,
      ciphertext
    );

    return new TextDecoder().decode(decrypted);
  }

  // ── Member Management ─────────────────────────────────────────────────

  /**
   * Add a new member to the group.
   * Rebuilds the tree and returns a full update.
   */
  async addMember(
    peerId: string,
    publicKey: CryptoKey
  ): Promise<TreeKEMUpdate> {
    const members = this.memberIds
      .filter(id => id !== peerId)
      .map(id => {
        const leafIdx = this.getLeafIndexForMember(id);
        return { peerId: id, publicKey: this.tree[leafIdx]!.publicKey! };
      });
    members.push({ peerId, publicKey });
    return this.buildTree(members);
  }

  /**
   * Remove a member from the group.
   * Rebuilds the tree and returns a full update.
   */
  async removeMember(peerId: string): Promise<TreeKEMUpdate> {
    const members = this.memberIds
      .filter(id => id !== peerId && id !== this.localUserId)
      .map(id => {
        const leafIdx = this.getLeafIndexForMember(id);
        return { peerId: id, publicKey: this.tree[leafIdx]!.publicKey! };
      });
    return this.buildTree(members);
  }

  // ── Configuration ─────────────────────────────────────────────────────

  configureAutoRotation(messageThreshold: number, timeThresholdMs: number): void {
    this.rotationMessageThreshold = messageThreshold;
    this.rotationTimeThresholdMs = timeThresholdMs;
  }

  onAutoRotation(callback: (update: TreeKEMUpdate) => Promise<void>): void {
    this.onRotationCallback = callback;
  }

  get epoch(): number {
    return this.currentEpoch;
  }

  get memberCount(): number {
    return this.memberIds.length;
  }

  getMessagesSinceRotation(): number {
    return this.messagesSinceRotation;
  }

  getMemberIds(): string[] {
    return [...this.memberIds];
  }

  hasGroupSecret(): boolean {
    return this.groupSecret !== null;
  }

  destroy(): void {
    this.tree = [];
    this.memberIds = [];
    this.leafIndex = -1;
    this.currentEpoch = 0;
    this.groupSecret = null;
    this.ecdhKeyPair = null;
    this.messagesSinceRotation = 0;
    this.lastRotationAt = 0;
    this.onRotationCallback = null;
  }

  // ── Binary Tree Helpers ───────────────────────────────────────────────

  /**
   * Get the direct path from a node to the root (excludes the node itself).
   */
  private getDirectPath(nodeIndex: number): number[] {
    const path: number[] = [];
    let current = nodeIndex;
    while (current !== 0) {
      current = this.getParent(current);
      path.push(current);
    }
    return path;
  }

  /**
   * Get the co-path: sibling of each node on the direct path.
   * These are the nodes whose subtrees need the encrypted path secrets.
   */
  private getCoPath(nodeIndex: number): number[] {
    const coPath: number[] = [];
    let current = nodeIndex;
    while (current !== 0) {
      coPath.push(this.getSibling(current));
      current = this.getParent(current);
    }
    return coPath;
  }

  private getParent(nodeIndex: number): number {
    return Math.floor((nodeIndex - 1) / 2);
  }

  private getSibling(nodeIndex: number): number {
    if (nodeIndex === 0) return 0; // root has no sibling
    return nodeIndex % 2 === 1 ? nodeIndex + 1 : nodeIndex - 1;
  }

  private getLeftChild(nodeIndex: number): number {
    return 2 * nodeIndex + 1;
  }

  private getRightChild(nodeIndex: number): number {
    return 2 * nodeIndex + 2;
  }

  /**
   * Find our node index that corresponds to a given co-path node.
   * Our node is the sibling of the co-path node on the direct path.
   */
  private findOurNodeForCoPath(coPathNodeIndex: number): number {
    // The sibling of the co-path node is on our direct path
    const siblingIdx = this.getSibling(coPathNodeIndex);

    // Check if we have a private key at the sibling or any descendant we own
    if (this.tree[siblingIdx]?.privateKey) return siblingIdx;

    // Walk down towards our leaf to find a node we have a key for
    return this.findOwnedDescendant(siblingIdx);
  }

  private findOwnedDescendant(nodeIndex: number): number {
    if (nodeIndex >= this.tree.length) return -1;
    if (this.tree[nodeIndex]?.privateKey) return nodeIndex;

    const left = this.findOwnedDescendant(this.getLeftChild(nodeIndex));
    if (left !== -1) return left;
    return this.findOwnedDescendant(this.getRightChild(nodeIndex));
  }

  /**
   * Find the public key of the parent of a co-path node from the update.
   */
  private findParentPublicKey(
    coPathNodeIndex: number,
    update: TreeKEMUpdate
  ): CryptoKey | null {
    const parentIdx = this.getParent(coPathNodeIndex);
    // Check if update has a public key for the parent's sibling (which is on sender's direct path)
    const fromUpdate = update.pathPublicKeys.find(pk => pk.nodeIndex === parentIdx);
    if (fromUpdate) {
      // We need to use the sender's path key for ECDH, but we have the co-path node
      // Actually, for ECDH we need the path node's public key (sender's side)
      const siblingOfCoPath = this.getSibling(coPathNodeIndex);
      const pathEntry = update.pathPublicKeys.find(pk => pk.nodeIndex === siblingOfCoPath);
      if (pathEntry) return null; // This is our own side, skip
    }

    // Use the node's public key from the tree for ECDH
    return this.tree[coPathNodeIndex]?.publicKey ?? null;
  }

  /**
   * Derive path secrets from a decrypted node secret up to root.
   */
  private async derivePathFromSecret(
    nodeIndex: number,
    _secret: ArrayBuffer
  ): Promise<void> {
    // Import the decrypted private key
    let currentKey: CryptoKey;
    try {
      currentKey = await crypto.subtle.importKey(
        'pkcs8',
        _secret,
        { name: 'ECDH', namedCurve: 'P-256' },
        false,
        ['deriveKey', 'deriveBits']
      );
    } catch {
      logger.warn('[TreeKEM] Failed to import path secret');
      return;
    }

    this.tree[nodeIndex]!.privateKey = currentKey;

    // Derive group key at root
    if (nodeIndex === 0) {
      const pubKey = this.tree[0]!.publicKey;
      if (pubKey) {
        this.groupSecret = await deriveGroupKey(currentKey, pubKey);
        this.tree[0]!.secret = this.groupSecret;
      }
    } else {
      // Walk up to root
      const pathToRoot = this.getDirectPath(nodeIndex);
      for (const idx of pathToRoot) {
        if (idx === 0) {
          const rootPub = this.tree[0]!.publicKey;
          if (rootPub) {
            this.groupSecret = await deriveGroupKey(currentKey, rootPub);
            this.tree[0]!.secret = this.groupSecret;
          }
        }
      }
    }
  }

  private getLeafIndexForMember(memberId: string): number {
    const memberIndex = this.memberIds.indexOf(memberId);
    if (memberIndex === -1) throw new Error(`Member "${memberId}" not found`);
    return TreeKEMManager.leafNodeIndex(memberIndex, this.memberIds.length);
  }

  // ── Static Tree Geometry ──────────────────────────────────────────────

  /**
   * Total node count for a left-balanced binary tree with N leaves.
   */
  static treeNodeCount(leafCount: number): number {
    if (leafCount <= 0) return 0;
    if (leafCount === 1) return 1;
    return 2 * leafCount - 1;
  }

  /**
   * Map leaf position (0-based) to tree node index.
   * Leaves are the bottom row of a left-balanced binary tree.
   */
  static leafNodeIndex(leafPosition: number, totalLeaves: number): number {
    if (totalLeaves <= 1) return 0;
    const treeSize = 2 * totalLeaves - 1;
    // Leaves start at index (treeSize - totalLeaves)
    return treeSize - totalLeaves + leafPosition;
  }

  /**
   * Get the depth of a tree with the given number of leaves.
   */
  static treeDepth(leafCount: number): number {
    if (leafCount <= 1) return 0;
    return Math.ceil(Math.log2(leafCount));
  }
}

// ── Utility Functions ────────────────────────────────────────────────────────

async function deriveGroupKey(
  privateKey: CryptoKey,
  publicKey: CryptoKey
): Promise<CryptoKey> {
  // Use ECDH to derive a group-wide AES key
  // In a proper TreeKEM this would use HKDF on the root secret
  return deriveSharedSecret(privateKey, publicKey);
}

async function exportPublicKey(key: CryptoKey): Promise<string> {
  const raw = await crypto.subtle.exportKey('raw', key);
  return bufferToBase64(raw);
}

async function importPublicKey(base64Key: string): Promise<CryptoKey> {
  const raw = base64ToBuffer(base64Key);
  return crypto.subtle.importKey(
    'raw',
    raw,
    { name: 'ECDH', namedCurve: 'P-256' },
    true,
    []
  );
}

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
