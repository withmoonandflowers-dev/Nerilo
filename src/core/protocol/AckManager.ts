import type { Envelope } from '../../types';
import { logger } from '../../utils/logger';

interface PendingEntry {
  peerId: string;
  env: Envelope;
  retryCount: number;
  timeoutId: ReturnType<typeof setTimeout>;
}

export class AckManager {
  private pending = new Map<string, PendingEntry>();

  constructor(
    private sendFn: (peerId: string, env: Envelope) => Promise<void>,
    private maxRetries = 3,
    private timeoutMs = 3000,
    private onPeerUnstable?: (peerId: string) => void
  ) {}

  track(peerId: string, env: Envelope): void {
    if (this.pending.has(env.id)) {
      return; // already tracking
    }
    const timeoutId = this.arm(peerId, env, 0);
    this.pending.set(env.id, { peerId, env, retryCount: 0, timeoutId });
  }

  ack(replyTo: string): void {
    const entry = this.pending.get(replyTo);
    if (entry) {
      clearTimeout(entry.timeoutId);
      this.pending.delete(replyTo);
    }
  }

  nack(replyTo: string): void {
    const entry = this.pending.get(replyTo);
    if (entry) {
      clearTimeout(entry.timeoutId);
      this.pending.delete(replyTo);
      this.onPeerUnstable?.(entry.peerId);
    }
  }

  hasPending(peerId: string): boolean {
    for (const entry of this.pending.values()) {
      if (entry.peerId === peerId) return true;
    }
    return false;
  }

  pendingCount(peerId: string): number {
    let count = 0;
    for (const entry of this.pending.values()) {
      if (entry.peerId === peerId) count++;
    }
    return count;
  }

  dispose(): void {
    for (const entry of this.pending.values()) {
      clearTimeout(entry.timeoutId);
    }
    this.pending.clear();
  }

  private arm(
    peerId: string,
    env: Envelope,
    currentRetry: number
  ): ReturnType<typeof setTimeout> {
    return setTimeout(() => {
      const entry = this.pending.get(env.id);
      if (!entry) return;

      if (currentRetry >= this.maxRetries) {
        this.pending.delete(env.id);
        this.onPeerUnstable?.(peerId);
        return;
      }

      const nextRetry = currentRetry + 1;
      this.sendFn(peerId, env).catch((e) => {
        logger.debug('[AckManager] Retry send failed, will retry on next timeout', { peerId, envId: env.id, e });
      });

      const newTimeoutId = this.arm(peerId, env, nextRetry);
      this.pending.set(env.id, { peerId, env, retryCount: nextRetry, timeoutId: newTimeoutId });
    }, this.timeoutMs);
  }
}
