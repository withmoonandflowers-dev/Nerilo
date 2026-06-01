/**
 * RemoteTelemetry — privacy-preserving remote metrics reporting.
 *
 * When `VITE_TELEMETRY_ENDPOINT` is set, snapshots from MetricsCollector are
 * aggregated for 60 seconds, anonymised (NO message content, NO room IDs,
 * NO user IDs), and POSTed in a single batch via `navigator.sendBeacon()`
 * so they reach the server even on tab close.
 *
 * Users can opt out at any time:
 *   localStorage.setItem('nerilo.telemetry.optout', '1')
 *
 * If the endpoint is unset, nothing is sent (MetricsExporter continues to
 * log to the console as before).
 *
 * Payload shape (per batch):
 *   {
 *     sessionId: string,          // opaque random id, per page load
 *     userAgent: string,          // navigator.userAgent (no fingerprinting)
 *     timestamp: number,          // ms epoch the batch was sent
 *     samples: Array<{
 *       timestamp: number,        // ms epoch the snapshot was captured
 *       connections: number,      // active channel count
 *       msgsPerSec: number,
 *       latency_p50: number,
 *       latency_p95: number,
 *       latency_p99: number,
 *       latency_samples: number,
 *       relay_hops: Record<number, number>,
 *       messages_sent: number,
 *       messages_received: number,
 *       messages_deduplicated: number,
 *       reachability_percent: number,
 *       backpressure_events: number,
 *     }>
 *   }
 *
 * Rate limit: max 1 POST per `BATCH_WINDOW_MS`. Excess snapshots within the
 * window are merged into the same batch.
 */

import type { MetricsSnapshot } from './MetricsCollector';

/** How long to accumulate snapshots before flushing a batch. */
const BATCH_WINDOW_MS = 60_000;

/** Maximum samples per batch (defence-in-depth — caller should not exceed). */
const MAX_SAMPLES_PER_BATCH = 60;

export interface TelemetrySample {
  timestamp: number;
  connections: number;
  msgsPerSec: number;
  latency_p50: number;
  latency_p95: number;
  latency_p99: number;
  latency_samples: number;
  relay_hops: Record<number, number>;
  messages_sent: number;
  messages_received: number;
  messages_deduplicated: number;
  reachability_percent: number;
  backpressure_events: number;
}

export interface TelemetryBatch {
  sessionId: string;
  userAgent: string;
  timestamp: number;
  samples: TelemetrySample[];
}

export interface RemoteTelemetryOptions {
  /** Override the destination URL (defaults to VITE_TELEMETRY_ENDPOINT). */
  endpoint?: string;
  /** Override the batch window in ms. Default 60_000. */
  batchWindowMs?: number;
  /**
   * Override the transport. Default uses navigator.sendBeacon when
   * available, otherwise falls back to fetch with keepalive.
   * Returns true if the send was accepted.
   */
  send?: (url: string, body: string) => boolean;
  /** Override the now() clock (used by tests). */
  now?: () => number;
  /**
   * Override the sessionId generator (used by tests). Default produces a
   * random hex string per RemoteTelemetry instance.
   */
  generateSessionId?: () => string;
}

function defaultSessionId(): string {
  // 16 random bytes → 32 hex chars. Avoids using crypto.randomUUID() so
  // ancient browsers and the jsdom test env keep working.
  if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
    const bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);
    return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  }
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

function defaultSend(url: string, body: string): boolean {
  if (typeof navigator !== 'undefined' && typeof navigator.sendBeacon === 'function') {
    // sendBeacon serialises the request synchronously and queues it for
    // background delivery — works even on tab close / page unload.
    try {
      return navigator.sendBeacon(url, body);
    } catch {
      // fall through to fetch
    }
  }
  if (typeof fetch === 'function') {
    // keepalive: true asks the browser to keep the request alive across
    // page unload, similar to sendBeacon.
    fetch(url, { method: 'POST', body, keepalive: true, headers: { 'Content-Type': 'application/json' } }).catch(
      () => undefined,
    );
    return true;
  }
  return false;
}

function isOptedOut(): boolean {
  try {
    if (typeof localStorage !== 'undefined' && localStorage.getItem('nerilo.telemetry.optout') === '1') {
      return true;
    }
  } catch {
    // localStorage blocked — fail open (continue reporting)
  }
  return false;
}

function snapshotToSample(snapshot: MetricsSnapshot, now: number): TelemetrySample {
  return {
    timestamp: now,
    connections: snapshot.activeChannels,
    msgsPerSec: snapshot.msgsPerSec,
    latency_p50: snapshot.latency.p50,
    latency_p95: snapshot.latency.p95,
    latency_p99: snapshot.latency.p99,
    latency_samples: snapshot.latency.samples,
    relay_hops: snapshot.hopDistribution,
    messages_sent: snapshot.totals.sent,
    messages_received: snapshot.totals.received,
    messages_deduplicated: snapshot.totals.deduplicated,
    reachability_percent: snapshot.reachabilityPercent,
    backpressure_events: snapshot.totals.backpressure,
  };
}

export class RemoteTelemetry {
  private readonly endpoint: string;
  private readonly batchWindowMs: number;
  private readonly send: (url: string, body: string) => boolean;
  private readonly now: () => number;
  private readonly sessionId: string;
  private readonly userAgent: string;

  private pending: TelemetrySample[] = [];
  private lastFlushAt: number;
  private unloadHandler: (() => void) | null = null;

  constructor(options: RemoteTelemetryOptions = {}) {
    const envEndpoint =
      typeof import.meta !== 'undefined'
        ? (import.meta as { env?: Record<string, string | undefined> }).env?.VITE_TELEMETRY_ENDPOINT
        : undefined;
    this.endpoint = options.endpoint ?? envEndpoint ?? '';
    this.batchWindowMs = options.batchWindowMs ?? BATCH_WINDOW_MS;
    this.send = options.send ?? defaultSend;
    this.now = options.now ?? (() => Date.now());
    this.sessionId = (options.generateSessionId ?? defaultSessionId)();
    this.userAgent = typeof navigator !== 'undefined' ? navigator.userAgent : 'unknown';
    // Treat construction as the first 'flush' tick so the very first record()
    // call doesn't immediately spill a single-sample batch.
    this.lastFlushAt = this.now();

    // Flush pending samples on tab unload — that's the whole point of using
    // sendBeacon. We only attach this handler if telemetry is actually
    // active (endpoint set + not opted out).
    if (this.isActive() && typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
      this.unloadHandler = () => {
        if (this.pending.length > 0) this.flush();
      };
      window.addEventListener('pagehide', this.unloadHandler);
      window.addEventListener('beforeunload', this.unloadHandler);
    }
  }

  /** True if telemetry is configured AND the user hasn't opted out. */
  isActive(): boolean {
    return this.endpoint.length > 0 && !isOptedOut();
  }

  /**
   * Submit a snapshot to the batch. Triggers a flush if BATCH_WINDOW_MS has
   * elapsed since the last flush.
   */
  record(snapshot: MetricsSnapshot): void {
    if (!this.isActive()) return;
    const now = this.now();
    this.pending.push(snapshotToSample(snapshot, now));
    if (this.pending.length > MAX_SAMPLES_PER_BATCH) {
      // Drop oldest to keep memory bounded
      this.pending = this.pending.slice(-MAX_SAMPLES_PER_BATCH);
    }
    if (now - this.lastFlushAt >= this.batchWindowMs) {
      this.flush();
    }
  }

  /** Force-send the current batch (no-op if pending is empty). */
  flush(): void {
    if (!this.isActive() || this.pending.length === 0) return;
    const batch: TelemetryBatch = {
      sessionId: this.sessionId,
      userAgent: this.userAgent,
      timestamp: this.now(),
      samples: this.pending,
    };
    this.pending = [];
    this.lastFlushAt = batch.timestamp;
    try {
      const body = JSON.stringify(batch);
      this.send(this.endpoint, body);
    } catch {
      // Never let telemetry crash the host app.
    }
  }

  /** Detach unload handlers. Called when the host app shuts down. */
  dispose(): void {
    if (this.unloadHandler && typeof window !== 'undefined') {
      window.removeEventListener('pagehide', this.unloadHandler);
      window.removeEventListener('beforeunload', this.unloadHandler);
      this.unloadHandler = null;
    }
    // Flush any remaining samples on dispose
    this.flush();
  }
}

/** Singleton — the only RemoteTelemetry instance during app lifetime. */
let activeTelemetry: RemoteTelemetry | null = null;

/**
 * Initialise the singleton with the bootstrap config. Idempotent: returns
 * the existing instance if already initialised.
 */
export function initRemoteTelemetry(options: RemoteTelemetryOptions = {}): RemoteTelemetry {
  if (!activeTelemetry) {
    activeTelemetry = new RemoteTelemetry(options);
  }
  return activeTelemetry;
}

/** Get the active singleton, or null if not initialised. */
export function getRemoteTelemetry(): RemoteTelemetry | null {
  return activeTelemetry;
}
