/**
 * ConnectionStats 測試（社群效能計畫 P0）
 *
 * - 計數與衍生率（directSuccessRate / restartRecoveryRate）
 * - localStorage 持久化 round-trip（stub）
 * - 無 localStorage 環境退化為記憶體模式不炸
 *
 * @vitest-environment node
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { connectionStats } from '../../src/core/metrics/ConnectionStats';

/** Map-backed localStorage stub（node 環境沒有原生 localStorage） */
function installLocalStorageStub(): Map<string, string> {
  const store = new Map<string, string>();
  (globalThis as Record<string, unknown>).localStorage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  };
  return store;
}

function removeLocalStorageStub(): void {
  delete (globalThis as Record<string, unknown>).localStorage;
}

describe('ConnectionStats', () => {
  beforeEach(() => {
    installLocalStorageStub();
    connectionStats.reset();
  });

  afterEach(() => {
    removeLocalStorageStub();
  });

  it('初始 snapshot 全零、rates 為 null', () => {
    const s = connectionStats.getSnapshot();
    expect(s.attempts).toBe(0);
    expect(s.directSuccessRate).toBeNull();
    expect(s.restartRecoveryRate).toBeNull();
    expect(s.since).toBeNull();
  });

  it('計數與衍生率正確', () => {
    connectionStats.recordAttempt();
    connectionStats.recordAttempt();
    connectionStats.recordAttempt();
    connectionStats.recordConnected();
    connectionStats.recordConnected();
    connectionStats.recordFailed();
    connectionStats.recordIceRestart();
    connectionStats.recordIceRestartRecovered();
    connectionStats.recordFallbackMessage();

    const s = connectionStats.getSnapshot();
    expect(s.attempts).toBe(3);
    expect(s.connected).toBe(2);
    expect(s.failed).toBe(1);
    expect(s.directSuccessRate).toBeCloseTo(2 / 3, 5);
    expect(s.restartRecoveryRate).toBe(1);
    expect(s.fallbackMessages).toBe(1);
    expect(s.since).not.toBeNull();
  });

  it('持久化 round-trip：寫入後 reload 還原', () => {
    connectionStats.recordAttempt();
    connectionStats.recordConnected();
    connectionStats.recordFallbackMessage();

    // 模擬新 session：從 storage 重載
    connectionStats.reload();
    const s = connectionStats.getSnapshot();
    expect(s.attempts).toBe(1);
    expect(s.connected).toBe(1);
    expect(s.fallbackMessages).toBe(1);
  });

  it('storage 內容毀損時退回全零不炸', () => {
    (globalThis as Record<string, unknown>).localStorage = {
      getItem: () => '{not json',
      setItem: () => void 0,
      removeItem: () => void 0,
    };
    connectionStats.reload();
    expect(connectionStats.getSnapshot().attempts).toBe(0);
  });

  it('無 localStorage 環境：記憶體模式照常計數', () => {
    removeLocalStorageStub();
    connectionStats.reset();
    connectionStats.recordAttempt();
    connectionStats.recordConnected();
    const s = connectionStats.getSnapshot();
    expect(s.attempts).toBe(1);
    expect(s.directSuccessRate).toBe(1);
  });
});
