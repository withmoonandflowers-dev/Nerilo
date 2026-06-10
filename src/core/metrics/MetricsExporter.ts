/**
 * MetricsExporter — periodic console.table dump of MetricsCollector snapshots.
 *
 * Opt-in via any of:
 *   - `localStorage.setItem('nerilo.metrics', '1')`
 *   - `window.__NERILO_METRICS__ = true`
 *   - URL: `?metrics=1`
 *
 * In development the exporter logs every 10s by default. In production it stays
 * silent unless the user explicitly opts in (so we don't leak peer IDs / room
 * stats in the console of a deployed build). The exporter is the only consumer
 * of MetricsCollector.getSnapshot() — DebugPanel uses the lower-level getters.
 *
 * Console output uses console.table directly (not the project logger) so it
 * renders as a proper table in DevTools instead of a JSON blob.
 */

import { metricsCollector, type MetricsSnapshot } from './MetricsCollector';
import { initRemoteTelemetry, type RemoteTelemetry } from './RemoteTelemetry';

const DEFAULT_INTERVAL_MS = 10_000;

export interface MetricsExporterOptions {
  /** Polling cadence in ms. Default 10000. */
  intervalMs?: number;
  /** Override the snapshot source (used by tests). */
  source?: { getSnapshot: () => MetricsSnapshot };
  /** Override the sink (used by tests). Default: console.table + console.log. */
  sink?: (snapshot: MetricsSnapshot) => void;
  /**
   * Override the remote telemetry sink (used by tests). Default routes to
   * the RemoteTelemetry singleton which is a no-op unless
   * VITE_TELEMETRY_ENDPOINT is set and the user hasn't opted out.
   */
  remote?: Pick<RemoteTelemetry, 'record'> | null;
}

function defaultSink(snapshot: MetricsSnapshot): void {
   
  console.groupCollapsed(`[Nerilo metrics] ${new Date().toISOString()}`);

   
  console.table({
    activeChannels: snapshot.activeChannels,
    msgsPerSec: snapshot.msgsPerSec,
    reachability: `${snapshot.reachabilityPercent}%`,
    sent: snapshot.totals.sent,
    received: snapshot.totals.received,
    dedup: snapshot.totals.deduplicated,
    backpressure: snapshot.totals.backpressure,
  });

   
  console.table(snapshot.latency);

  if (Object.keys(snapshot.hopDistribution).length > 0) {
     
    console.table(snapshot.hopDistribution);
  }

  if (Object.keys(snapshot.buffer).length > 0) {
     
    console.table(snapshot.buffer);
  }

   
  console.groupEnd();
}

function isEnabled(): boolean {
  if (typeof window === 'undefined') return false;
  const w = window as unknown as { __NERILO_METRICS__?: boolean };
  if (w.__NERILO_METRICS__ === true) return true;
  try {
    if (typeof localStorage !== 'undefined' && localStorage.getItem('nerilo.metrics') === '1') {
      return true;
    }
  } catch {
    // localStorage blocked (private mode, file://) — fall through
  }
  try {
    const params = new URLSearchParams(window.location.search);
    if (params.get('metrics') === '1') return true;
  } catch {
    // URL not available
  }
  return false;
}

/**
 * Start the periodic exporter. Returns a stop() function. Idempotent — if an
 * exporter is already running, the existing handle is returned.
 */
let activeHandle: { stop: () => void } | null = null;

export function startMetricsExporter(options: MetricsExporterOptions = {}): { stop: () => void } {
  if (activeHandle) return activeHandle;

  const intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
  const source = options.source ?? metricsCollector;
  const sink = options.sink ?? defaultSink;
  // Default remote = the singleton. Tests pass `remote: null` to disable.
  const remote = options.remote === undefined ? initRemoteTelemetry() : options.remote;

  const id = setInterval(() => {
    try {
      const snapshot = source.getSnapshot();
      sink(snapshot);
      remote?.record(snapshot);
    } catch {
      // never let metrics export crash the host app
    }
  }, intervalMs);

  activeHandle = {
    stop: () => {
      clearInterval(id);
      activeHandle = null;
    },
  };
  return activeHandle;
}

/**
 * Auto-start helper called from app bootstrap. No-op unless the user has
 * opted in via the flags above.
 */
export function autoStartMetricsExporter(options: MetricsExporterOptions = {}): void {
  if (!isEnabled()) return;
  startMetricsExporter(options);
}
