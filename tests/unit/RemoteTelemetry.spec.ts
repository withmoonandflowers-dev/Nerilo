/**
 * RemoteTelemetry unit tests.
 *
 * Verifies:
 *   - inactive when endpoint unset
 *   - inactive when user has opted out via localStorage
 *   - batches snapshots and flushes after batchWindowMs
 *   - payload contains anonymised metrics (NO content / room / user IDs)
 *   - flush is idempotent on empty buffer
 *   - dispose flushes pending samples
 *   - rate-limited: many records within window → one send
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { RemoteTelemetry } from '../../src/core/metrics/RemoteTelemetry';
import type { MetricsSnapshot } from '../../src/core/metrics/MetricsCollector';

function makeSnapshot(overrides: Partial<MetricsSnapshot> = {}): MetricsSnapshot {
  return {
    activeChannels: 3,
    msgsPerSec: 1.5,
    latency: { p50: 50, p95: 120, p99: 200, avg: 65, samples: 100 },
    hopDistribution: { 1: 5, 2: 10, 3: 2 },
    buffer: {},
    reachabilityPercent: 99.5,
    totals: { sent: 42, received: 38, deduplicated: 1, backpressure: 0 },
    ...overrides,
  };
}

describe('RemoteTelemetry', () => {
  beforeEach(() => {
    // jsdom localStorage clean between tests
    try {
      localStorage.clear();
    } catch {
      /* ignore */
    }
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('isActive returns false when endpoint is empty', () => {
    const t = new RemoteTelemetry({ endpoint: '' });
    expect(t.isActive()).toBe(false);
  });

  it('isActive returns true when endpoint is set', () => {
    const t = new RemoteTelemetry({ endpoint: 'https://example.test/m' });
    expect(t.isActive()).toBe(true);
  });

  it('isActive returns false when user opted out via localStorage', () => {
    localStorage.setItem('nerilo.telemetry.optout', '1');
    const t = new RemoteTelemetry({ endpoint: 'https://example.test/m' });
    expect(t.isActive()).toBe(false);
  });

  it('record is a no-op when telemetry is inactive', () => {
    const send = vi.fn(() => true);
    const t = new RemoteTelemetry({ endpoint: '', send });
    t.record(makeSnapshot());
    t.flush();
    expect(send).not.toHaveBeenCalled();
  });

  it('accumulates samples and flushes once batchWindowMs has elapsed', () => {
    let now = 1_000_000;
    const send = vi.fn(() => true);
    const t = new RemoteTelemetry({
      endpoint: 'https://example.test/m',
      batchWindowMs: 60_000,
      send,
      now: () => now,
    });

    t.record(makeSnapshot()); // first sample at t=1_000_000
    expect(send).not.toHaveBeenCalled();

    now += 30_000;
    t.record(makeSnapshot()); // 30s later, still within window
    expect(send).not.toHaveBeenCalled();

    now += 35_000; // 65s past first sample → triggers flush
    t.record(makeSnapshot());
    expect(send).toHaveBeenCalledTimes(1);

    const body = JSON.parse(send.mock.calls[0][1]);
    expect(body.samples).toHaveLength(3);
    expect(body.sessionId).toMatch(/^[a-z0-9]+$/);
    expect(body.timestamp).toBeGreaterThan(0);
  });

  it('payload contains anonymised metrics only — no content / room / user IDs', () => {
    const send = vi.fn(() => true);
    const t = new RemoteTelemetry({
      endpoint: 'https://example.test/m',
      send,
      now: () => 1000,
    });
    t.record(
      makeSnapshot({
        // Even if we passed extra fields, the sample shape strips them.
        hopDistribution: { 2: 5 },
        buffer: { 'peer-id-with-pii:control': 1024 }, // PII in the buffer key
      }),
    );
    t.flush();
    expect(send).toHaveBeenCalledTimes(1);
    const body = send.mock.calls[0][1];
    // No peer IDs, no room IDs, no message content of any form.
    expect(body).not.toContain('peer-id');
    expect(body).not.toContain('control');
    expect(body).not.toContain('uid');
    expect(body).not.toContain('roomId');
    // But it DOES contain the anonymised numeric metrics.
    const parsed = JSON.parse(body);
    expect(parsed.samples[0]).toMatchObject({
      connections: 3,
      msgsPerSec: 1.5,
      latency_p50: 50,
      latency_p95: 120,
      messages_sent: 42,
    });
  });

  it('multiple records within batchWindow result in one POST (rate-limited)', () => {
    let now = 1000;
    const send = vi.fn(() => true);
    const t = new RemoteTelemetry({
      endpoint: 'https://example.test/m',
      batchWindowMs: 60_000,
      send,
      now: () => now,
    });
    for (let i = 0; i < 10; i++) {
      now += 1000; // 1 record/sec for 10 seconds
      t.record(makeSnapshot());
    }
    // 10 records in 10 s, window is 60 s → 0 sends so far
    expect(send).not.toHaveBeenCalled();

    t.flush();
    expect(send).toHaveBeenCalledTimes(1);
    const body = JSON.parse(send.mock.calls[0][1]);
    expect(body.samples).toHaveLength(10);
  });

  it('flush is a no-op when pending is empty', () => {
    const send = vi.fn(() => true);
    const t = new RemoteTelemetry({
      endpoint: 'https://example.test/m',
      send,
    });
    t.flush();
    t.flush();
    expect(send).not.toHaveBeenCalled();
  });

  it('dispose flushes any pending samples', () => {
    const send = vi.fn(() => true);
    const t = new RemoteTelemetry({
      endpoint: 'https://example.test/m',
      send,
    });
    t.record(makeSnapshot());
    expect(send).not.toHaveBeenCalled();
    t.dispose();
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('uses navigator.sendBeacon when available', () => {
    const beacon = vi.fn(() => true);
    vi.stubGlobal('navigator', { sendBeacon: beacon, userAgent: 'test' });
    const t = new RemoteTelemetry({ endpoint: 'https://example.test/m' });
    t.record(makeSnapshot());
    t.flush();
    expect(beacon).toHaveBeenCalledTimes(1);
    expect(beacon.mock.calls[0][0]).toBe('https://example.test/m');
    vi.unstubAllGlobals();
  });

  it('falls back to fetch when sendBeacon is unavailable', () => {
    const fetchStub = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal('fetch', fetchStub);
    vi.stubGlobal('navigator', { userAgent: 'test' }); // no sendBeacon
    const t = new RemoteTelemetry({ endpoint: 'https://example.test/m' });
    t.record(makeSnapshot());
    t.flush();
    expect(fetchStub).toHaveBeenCalledTimes(1);
    const [url, init] = fetchStub.mock.calls[0];
    expect(url).toBe('https://example.test/m');
    expect((init as RequestInit).method).toBe('POST');
    expect((init as RequestInit).keepalive).toBe(true);
    vi.unstubAllGlobals();
  });

  it('exceptions in send do not crash record/flush', () => {
    const send = vi.fn(() => {
      throw new Error('boom');
    });
    const t = new RemoteTelemetry({
      endpoint: 'https://example.test/m',
      send,
    });
    expect(() => {
      t.record(makeSnapshot());
      t.flush();
    }).not.toThrow();
  });
});
