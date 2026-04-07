/**
 * CoverTrafficGenerator — Poisson-distributed dummy traffic
 *
 * Generates cover traffic (dummy packets) to prevent traffic analysis.
 * Real and cover packets are indistinguishable to relay nodes because:
 * - Same fixed packet size (via MessagePadding)
 * - Same encryption layers (via SphinxPacket)
 * - Poisson-distributed timing (no pattern to correlate)
 *
 * Parameters (based on Nym/Loopix research):
 * - λ (lambda): Average packets per second (default 0.5)
 *   - Higher λ = better anonymity, more bandwidth
 *   - Lower λ = less overhead, weaker protection
 * - Battery-aware mode: reduces λ when on battery
 *
 * Cover packet lifecycle:
 * 1. Generate at Poisson intervals
 * 2. Encrypt as Sphinx packet (loop message back to self or drop)
 * 3. Send through relay network
 * 4. Relay nodes cannot distinguish from real traffic
 * 5. Drop message at final hop (or self-delivery as keep-alive)
 */

import type { CoverTrafficConfig } from './types';

const DEFAULT_CONFIG: CoverTrafficConfig = {
  enabled: false,
  poissonLambda: 0.5, // avg 1 packet per 2 seconds
  packetSize: 4096,
  batteryAware: true,
  batteryMinRate: 0.2, // 20% of normal rate on battery
};

/** Callback to send a cover packet through the relay network */
export type CoverPacketSender = (dummyPayload: Uint8Array) => Promise<void>;

export class CoverTrafficGenerator {
  private config: CoverTrafficConfig;
  private sender: CoverPacketSender | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running = false;
  private packetsSent = 0;
  private lastPacketAt = 0;
  private onBattery = false;

  constructor(config: Partial<CoverTrafficConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /** Set the function used to send cover packets */
  setSender(sender: CoverPacketSender): void {
    this.sender = sender;
  }

  /** Start generating cover traffic */
  start(): void {
    if (this.running || !this.config.enabled) return;
    this.running = true;
    this.scheduleNext();
  }

  /** Stop generating cover traffic */
  stop(): void {
    this.running = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  /** Enable or disable cover traffic */
  setEnabled(enabled: boolean): void {
    this.config.enabled = enabled;
    if (enabled && !this.running) {
      this.start();
    } else if (!enabled && this.running) {
      this.stop();
    }
  }

  /** Update the Poisson lambda parameter */
  setLambda(lambda: number): void {
    if (lambda <= 0) throw new Error('Lambda must be positive');
    this.config.poissonLambda = lambda;
  }

  /** Set battery status (affects cover traffic rate) */
  setBatteryStatus(onBattery: boolean): void {
    this.onBattery = onBattery;
  }

  /** Get the current configuration */
  getConfig(): CoverTrafficConfig {
    return { ...this.config };
  }

  /** Get statistics */
  getStats(): { packetsSent: number; lastPacketAt: number; isRunning: boolean } {
    return {
      packetsSent: this.packetsSent,
      lastPacketAt: this.lastPacketAt,
      isRunning: this.running,
    };
  }

  /** Clean up */
  destroy(): void {
    this.stop();
    this.sender = null;
    this.packetsSent = 0;
  }

  // ── Internal ─────────────────────────────────────────────────────────────

  /** Schedule the next cover packet using Poisson timing */
  private scheduleNext(): void {
    if (!this.running) return;

    const lambda = this.getEffectiveLambda();
    const delayMs = this.poissonDelay(lambda);

    this.timer = setTimeout(async () => {
      await this.sendCoverPacket();
      this.scheduleNext();
    }, delayMs);
  }

  /** Get effective lambda considering battery status */
  private getEffectiveLambda(): number {
    if (this.onBattery && this.config.batteryAware) {
      return this.config.poissonLambda * this.config.batteryMinRate;
    }
    return this.config.poissonLambda;
  }

  /**
   * Generate Poisson inter-arrival time.
   * Uses inverse transform sampling: -ln(U) / λ
   * where U is uniform(0,1) and λ is packets per second.
   */
  private poissonDelay(lambda: number): number {
    const u = Math.random();
    // Avoid log(0)
    const safeU = Math.max(u, 1e-10);
    const delaySec = -Math.log(safeU) / lambda;
    // Clamp to reasonable range: 100ms to 30s
    return Math.max(100, Math.min(30_000, delaySec * 1000));
  }

  /** Generate and send a dummy cover packet */
  private async sendCoverPacket(): Promise<void> {
    if (!this.sender) return;

    try {
      // Generate random payload (indistinguishable from encrypted real data)
      const dummyPayload = crypto.getRandomValues(
        new Uint8Array(this.config.packetSize)
      );

      await this.sender(dummyPayload);

      this.packetsSent++;
      this.lastPacketAt = Date.now();
    } catch {
      // Best-effort — cover traffic failures are not critical
    }
  }
}
