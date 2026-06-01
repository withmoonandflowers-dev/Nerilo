/**
 * MessageAssembler — Receiver-side deduplication and fragment reassembly
 *
 * When messages arrive via multiple relay paths simultaneously,
 * the assembler ensures only one copy is delivered to the application.
 *
 * Strategy: First-Arrival-Wins
 * - The first complete message (by messageId) is accepted
 * - Subsequent duplicates from other paths are dropped
 * - Path quality feedback is generated for each arrival
 *
 * Also handles fragment reassembly for large messages split
 * across multiple packets by FragmentManager.
 */

import type { MessageFragment, AssemblyStatus } from './types';

/** TTL for seen message cache entries (ms) */
const SEEN_TTL_MS = 300_000; // 5 minutes
/** Maximum entries in the seen cache (LRU eviction) */
const SEEN_MAX_ENTRIES = 10_000;
/** Cleanup interval for expired entries */
const CLEANUP_INTERVAL_MS = 60_000; // 1 minute
/** Maximum time to wait for all fragments before timeout */
const FRAGMENT_TIMEOUT_MS = 30_000; // 30 seconds
/** Maximum pending fragment assemblies (prevents memory DoS) */
const MAX_PENDING_FRAGMENTS = 1000;
/** Maximum fragments per message (prevents totalFragments abuse) */
const MAX_FRAGMENTS_PER_MESSAGE = 100;

/** Callback for assembled message delivery */
export type MessageHandler = (messageId: string, payload: Uint8Array, pathId: string) => void;

/** Callback for path quality feedback */
export type PathFeedbackHandler = (
  messageId: string,
  pathId: string,
  isFirstArrival: boolean,
  latencyMs: number
) => void;

interface SeenEntry {
  /** Timestamp when first seen */
  firstSeenAt: number;
  /** Which path delivered first */
  winningPathId: string;
  /** Count of duplicate arrivals */
  duplicateCount: number;
}

interface FragmentState {
  /** Received fragments indexed by fragmentIndex */
  fragments: Map<number, Uint8Array>;
  /** Total fragments expected */
  totalFragments: number;
  /** Winning path ID (first fragment's path) */
  winningPathId: string;
  /** Timestamp of first fragment */
  firstFragmentAt: number;
  /** Whether assembly is complete */
  isComplete: boolean;
}

export class MessageAssembler {
  private seenMessages = new Map<string, SeenEntry>();
  private fragmentStates = new Map<string, FragmentState>();
  private messageHandler: MessageHandler | null = null;
  private pathFeedbackHandler: PathFeedbackHandler | null = null;
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;
  /** Insertion order tracking for LRU eviction */
  private insertionOrder: string[] = [];

  /** Set the handler for complete assembled messages */
  onMessage(handler: MessageHandler): void {
    this.messageHandler = handler;
  }

  /** Set the handler for path quality feedback */
  onPathFeedback(handler: PathFeedbackHandler): void {
    this.pathFeedbackHandler = handler;
  }

  /** Start the cleanup timer */
  start(): void {
    if (this.cleanupTimer) return;
    this.cleanupTimer = setInterval(() => this.cleanup(), CLEANUP_INTERVAL_MS);
  }

  /** Stop the cleanup timer */
  stop(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
  }

  /**
   * Process an incoming complete message (non-fragmented).
   * Returns true if this is the first arrival (accepted), false if duplicate.
   */
  processMessage(messageId: string, payload: Uint8Array, pathId: string): boolean {
    const now = Date.now();
    const existing = this.seenMessages.get(messageId);

    if (existing) {
      // Duplicate — record and emit feedback
      existing.duplicateCount++;
      this.emitFeedback(messageId, pathId, false, now - existing.firstSeenAt);
      return false;
    }

    // First arrival — record and deliver
    this.recordSeen(messageId, pathId, now);
    this.emitFeedback(messageId, pathId, true, 0);

    if (this.messageHandler) {
      this.messageHandler(messageId, payload, pathId);
    }

    return true;
  }

  /**
   * Process an incoming message fragment.
   * Returns the assembly status.
   */
  processFragment(fragment: MessageFragment): AssemblyStatus {
    const now = Date.now();
    const { messageId, fragmentIndex, totalFragments, data, pathId } = fragment;

    // Check if this message was already fully assembled
    if (this.seenMessages.has(messageId)) {
      const existing = this.seenMessages.get(messageId)!;
      existing.duplicateCount++;
      return {
        messageId,
        receivedFragments: totalFragments,
        totalFragments,
        winningPathId: existing.winningPathId,
        firstArrivalAt: existing.firstSeenAt,
        isComplete: true,
      };
    }

    // Validate totalFragments to prevent memory abuse
    if (totalFragments > MAX_FRAGMENTS_PER_MESSAGE) {
      return {
        messageId,
        receivedFragments: 0,
        totalFragments,
        winningPathId: pathId,
        firstArrivalAt: now,
        isComplete: false,
      };
    }

    // Get or create fragment state
    let state = this.fragmentStates.get(messageId);
    if (!state) {
      // Reject if too many pending assemblies (DoS protection)
      if (this.fragmentStates.size >= MAX_PENDING_FRAGMENTS) {
        return {
          messageId,
          receivedFragments: 0,
          totalFragments,
          winningPathId: pathId,
          firstArrivalAt: now,
          isComplete: false,
        };
      }

      state = {
        fragments: new Map(),
        totalFragments,
        winningPathId: pathId,
        firstFragmentAt: now,
        isComplete: false,
      };
      this.fragmentStates.set(messageId, state);
    }

    // Store fragment (skip if already have this index)
    if (!state.fragments.has(fragmentIndex)) {
      state.fragments.set(fragmentIndex, base64ToBytes(data));
    }

    // Check if all fragments received
    if (state.fragments.size >= state.totalFragments) {
      state.isComplete = true;

      // Reassemble
      const assembled = this.reassemble(state);

      // Mark as seen and deliver
      this.recordSeen(messageId, state.winningPathId, state.firstFragmentAt);
      this.fragmentStates.delete(messageId);

      this.emitFeedback(messageId, state.winningPathId, true, 0);

      if (this.messageHandler && assembled) {
        this.messageHandler(messageId, assembled, state.winningPathId);
      }
    }

    return {
      messageId,
      receivedFragments: state.fragments.size,
      totalFragments: state.totalFragments,
      winningPathId: state.winningPathId,
      firstArrivalAt: state.firstFragmentAt,
      isComplete: state.isComplete,
    };
  }

  /** Get the assembly status for a message */
  getStatus(messageId: string): AssemblyStatus | null {
    const seen = this.seenMessages.get(messageId);
    if (seen) {
      return {
        messageId,
        receivedFragments: 0, // Already assembled
        totalFragments: 0,
        winningPathId: seen.winningPathId,
        firstArrivalAt: seen.firstSeenAt,
        isComplete: true,
      };
    }

    const state = this.fragmentStates.get(messageId);
    if (!state) return null;

    return {
      messageId,
      receivedFragments: state.fragments.size,
      totalFragments: state.totalFragments,
      winningPathId: state.winningPathId,
      firstArrivalAt: state.firstFragmentAt,
      isComplete: state.isComplete,
    };
  }

  /** Check if a message has been seen */
  hasSeen(messageId: string): boolean {
    return this.seenMessages.has(messageId);
  }

  /** Get the number of seen messages */
  getSeenCount(): number {
    return this.seenMessages.size;
  }

  /** Get the number of pending fragment assemblies */
  getPendingCount(): number {
    return this.fragmentStates.size;
  }

  /** Clear all state */
  clear(): void {
    this.seenMessages.clear();
    this.fragmentStates.clear();
    this.insertionOrder = [];
  }

  /** Clean up */
  destroy(): void {
    this.stop();
    this.clear();
    this.messageHandler = null;
    this.pathFeedbackHandler = null;
  }

  // ── Internal ─────────────────────────────────────────────────────────────

  private recordSeen(messageId: string, pathId: string, timestamp: number): void {
    this.seenMessages.set(messageId, {
      firstSeenAt: timestamp,
      winningPathId: pathId,
      duplicateCount: 0,
    });
    this.insertionOrder.push(messageId);

    // LRU eviction
    while (this.seenMessages.size > SEEN_MAX_ENTRIES && this.insertionOrder.length > 0) {
      const oldest = this.insertionOrder.shift()!;
      this.seenMessages.delete(oldest);
    }
  }

  private reassemble(state: FragmentState): Uint8Array | null {
    // Concatenate fragments in order
    const parts: Uint8Array[] = [];
    for (let i = 0; i < state.totalFragments; i++) {
      const frag = state.fragments.get(i);
      if (!frag) return null; // Missing fragment
      parts.push(frag);
    }

    const totalLength = parts.reduce((sum, p) => sum + p.length, 0);
    const result = new Uint8Array(totalLength);
    let offset = 0;
    for (const part of parts) {
      result.set(part, offset);
      offset += part.length;
    }
    return result;
  }

  private emitFeedback(
    messageId: string,
    pathId: string,
    isFirstArrival: boolean,
    latencyMs: number
  ): void {
    if (this.pathFeedbackHandler) {
      this.pathFeedbackHandler(messageId, pathId, isFirstArrival, latencyMs);
    }
  }

  private cleanup(): void {
    const now = Date.now();

    // Clean expired seen entries
    for (const [id, entry] of this.seenMessages) {
      if (now - entry.firstSeenAt > SEEN_TTL_MS) {
        this.seenMessages.delete(id);
      }
    }

    // Clean timed-out fragment assemblies
    for (const [id, state] of this.fragmentStates) {
      if (now - state.firstFragmentAt > FRAGMENT_TIMEOUT_MS) {
        this.fragmentStates.delete(id);
      }
    }

    // Trim insertion order
    this.insertionOrder = this.insertionOrder.filter((id) => this.seenMessages.has(id));
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function base64ToBytes(base64: string): Uint8Array {
  let binary: string;
  try {
    binary = atob(base64);
  } catch {
    throw new Error('Invalid base64 input');
  }
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}
