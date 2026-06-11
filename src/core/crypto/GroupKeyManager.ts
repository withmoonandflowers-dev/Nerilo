/**
 * GroupKeyManager — Adaptive Group Key Distribution
 *
 * Automatically selects the optimal key distribution strategy:
 *   - Small groups (<50 members): SenderKeyManager — simple, proven, fast init
 *   - Large groups (>=50 members): TreeKEMManager — O(log N) key rotation
 *
 * Provides a unified API that abstracts the underlying strategy.
 * ChatService can use GroupKeyManager instead of SenderKeyManager directly.
 *
 * Strategy switching happens on member add/remove when crossing the threshold.
 */

import { logger } from '../../utils/logger';
import {
  SenderKeyManager,
  type EncryptedPayload,
  type SenderKeyDistribution,
} from './SenderKeyManager';
import {
  TreeKEMManager,
  type TreeKEMUpdate,
} from './TreeKEMManager';

export type KeyStrategy = 'sender-key' | 'tree-kem';

export type KeyDistributionMessage = SenderKeyDistribution | TreeKEMUpdate;

export interface GroupKeyManagerConfig {
  /** Member count threshold for switching to TreeKEM (default: 50) */
  treeKEMThreshold: number;
  /** Auto-rotation message threshold (default: 100) */
  rotationMessageThreshold: number;
  /** Auto-rotation time threshold in ms (default: 1 hour) */
  rotationTimeThresholdMs: number;
}

const DEFAULT_CONFIG: GroupKeyManagerConfig = {
  treeKEMThreshold: 50,
  rotationMessageThreshold: 100,
  rotationTimeThresholdMs: 3600_000,
};

interface PeerPublicKey {
  peerId: string;
  publicKey: CryptoKey;
}

export class GroupKeyManager {
  private config: GroupKeyManagerConfig;
  private strategy: KeyStrategy = 'sender-key';
  private senderKey: SenderKeyManager;
  private treeKEM: TreeKEMManager;
  private members: PeerPublicKey[] = [];
  private initialized = false;

  constructor(
    localUserId: string,
    config: Partial<GroupKeyManagerConfig> = {}
  ) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.senderKey = new SenderKeyManager(localUserId);
    this.treeKEM = new TreeKEMManager(localUserId);
  }

  // ── Initialization ──────────────────────────────────────────────────────

  /**
   * Initialize key pairs for both strategies.
   * Returns the ECDH public key to share with peers.
   */
  async init(): Promise<CryptoKey> {
    const pubKey = await this.senderKey.initKeyPair();
    await this.treeKEM.initKeyPair();
    this.initialized = true;
    return pubKey;
  }

  /**
   * Set up the group with initial members.
   * Automatically selects strategy based on member count.
   */
  async setupGroup(
    members: PeerPublicKey[]
  ): Promise<KeyDistributionMessage> {
    if (!this.initialized) {
      throw new Error('Call init() first');
    }

    this.members = [...members];
    this.strategy = this.selectStrategy(members.length + 1); // +1 for self

    logger.info('[GroupKeyManager] Strategy selected', {
      strategy: this.strategy,
      memberCount: members.length + 1,
    });

    if (this.strategy === 'tree-kem') {
      return this.treeKEM.buildTree(members);
    }

    // SenderKey path
    await this.senderKey.generateSenderKey();
    this.senderKey.updateMembers(members);
    return this.senderKey.distributeSenderKey(members);
  }

  // ── Encryption/Decryption ─────────────────────────────────────────────

  /**
   * Encrypt a message using the current strategy's group key.
   */
  async encryptMessage(plaintext: string): Promise<EncryptedPayload> {
    if (this.strategy === 'tree-kem') {
      return this.treeKEM.encryptMessage(plaintext);
    }
    return this.senderKey.encryptMessage(plaintext);
  }

  /**
   * Decrypt a message.
   * For SenderKey, requires senderId to look up the correct key.
   * For TreeKEM, uses the shared group secret.
   */
  async decryptMessage(
    payload: EncryptedPayload,
    senderId: string
  ): Promise<string> {
    if (this.strategy === 'tree-kem') {
      return this.treeKEM.decryptMessage(payload);
    }
    return this.senderKey.decryptMessage(payload, senderId);
  }

  // ── Key Distribution Reception ────────────────────────────────────────

  /**
   * Receive a SenderKey distribution from a peer.
   */
  async receiveSenderKeyDistribution(
    distribution: SenderKeyDistribution,
    senderPublicKey: CryptoKey
  ): Promise<void> {
    await this.senderKey.receiveSenderKey(distribution, senderPublicKey);
  }

  /**
   * Process a TreeKEM update from a peer.
   */
  async processTreeKEMUpdate(update: TreeKEMUpdate): Promise<void> {
    await this.treeKEM.processUpdate(update);
  }

  // ── Member Management ─────────────────────────────────────────────────

  /**
   * Add a member to the group. May trigger strategy switch.
   */
  async addMember(
    peerId: string,
    publicKey: CryptoKey
  ): Promise<KeyDistributionMessage> {
    this.members.push({ peerId, publicKey });
    const totalMembers = this.members.length + 1; // +1 for self

    const newStrategy = this.selectStrategy(totalMembers);

    if (newStrategy !== this.strategy) {
      logger.info('[GroupKeyManager] Strategy switch', {
        from: this.strategy,
        to: newStrategy,
        memberCount: totalMembers,
      });
      this.strategy = newStrategy;
      return this.setupGroup(this.members);
    }

    if (this.strategy === 'tree-kem') {
      return this.treeKEM.addMember(peerId, publicKey);
    }

    // SenderKey: force rotation to include new member
    this.senderKey.updateMembers(this.members);
    const dist = await this.senderKey.forceRotation(this.members);
    if (!dist) throw new Error('Failed to distribute key after member add');
    return dist;
  }

  /**
   * Remove a member from the group. May trigger strategy switch.
   */
  async removeMember(peerId: string): Promise<KeyDistributionMessage> {
    this.members = this.members.filter(m => m.peerId !== peerId);
    const totalMembers = this.members.length + 1;

    const newStrategy = this.selectStrategy(totalMembers);

    if (newStrategy !== this.strategy) {
      logger.info('[GroupKeyManager] Strategy switch', {
        from: this.strategy,
        to: newStrategy,
        memberCount: totalMembers,
      });
      this.strategy = newStrategy;
      return this.setupGroup(this.members);
    }

    if (this.strategy === 'tree-kem') {
      return this.treeKEM.removeMember(peerId);
    }

    // SenderKey: force rotation excluding removed member
    this.senderKey.removePeerKey(peerId);
    this.senderKey.updateMembers(this.members);
    const dist = await this.senderKey.forceRotation(this.members);
    if (!dist) throw new Error('Failed to distribute key after member remove');
    return dist;
  }

  // ── Auto-Rotation ─────────────────────────────────────────────────────

  /**
   * Check and perform auto-rotation if thresholds are met.
   */
  async checkAutoRotation(): Promise<KeyDistributionMessage | null> {
    if (this.strategy === 'tree-kem') {
      return this.treeKEM.checkAutoRotation();
    }
    return this.senderKey.checkAutoRotation();
  }

  /**
   * Force an immediate key rotation.
   */
  async forceRotation(): Promise<KeyDistributionMessage | null> {
    if (this.strategy === 'tree-kem') {
      return this.treeKEM.forceRotation();
    }
    return this.senderKey.forceRotation();
  }

  /**
   * Set auto-rotation callback.
   */
  onAutoRotation(callback: (msg: KeyDistributionMessage) => Promise<void>): void {
    this.senderKey.onAutoRotation(callback as (d: SenderKeyDistribution) => Promise<void>);
    this.treeKEM.onAutoRotation(callback as (u: TreeKEMUpdate) => Promise<void>);
  }

  configureAutoRotation(messageThreshold: number, timeThresholdMs: number): void {
    this.config.rotationMessageThreshold = messageThreshold;
    this.config.rotationTimeThresholdMs = timeThresholdMs;
    this.senderKey.configureAutoRotation(messageThreshold, timeThresholdMs);
    this.treeKEM.configureAutoRotation(messageThreshold, timeThresholdMs);
  }

  // ── Queries ───────────────────────────────────────────────────────────

  getStrategy(): KeyStrategy {
    return this.strategy;
  }

  getEpoch(): number {
    return this.strategy === 'tree-kem' ? this.treeKEM.epoch : this.senderKey.epoch;
  }

  getMessagesSinceRotation(): number {
    return this.strategy === 'tree-kem'
      ? this.treeKEM.getMessagesSinceRotation()
      : this.senderKey.getMessagesSinceRotation();
  }

  getMemberCount(): number {
    return this.members.length + 1; // +1 for self
  }

  getThreshold(): number {
    return this.config.treeKEMThreshold;
  }

  isInitialized(): boolean {
    return this.initialized;
  }

  destroy(): void {
    this.senderKey.destroy();
    this.treeKEM.destroy();
    this.members = [];
    this.initialized = false;
  }

  // ── Internal ──────────────────────────────────────────────────────────

  private selectStrategy(totalMembers: number): KeyStrategy {
    // Hysteresis: switch up at threshold, switch down at threshold - 10
    if (this.strategy === 'sender-key' && totalMembers >= this.config.treeKEMThreshold) {
      return 'tree-kem';
    }
    if (this.strategy === 'tree-kem' && totalMembers < this.config.treeKEMThreshold - 10) {
      return 'sender-key';
    }
    return this.strategy;
  }
}
