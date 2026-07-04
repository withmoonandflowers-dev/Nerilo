/**
 * ConnectionStats — 直連成敗與 fallback 觸發率量測（社群效能計畫 P0）
 *
 * 回答一個投資決策問題：「直連失敗率有多高？」——這個數字決定
 * 社群中繼（ADR-0012 P2 接線）值不值得做。若直連成功率 >95%，
 * peer 中繼的優先級應該降；若 fallback 觸發率高，P2 收益立即。
 *
 * 設計：
 * - 純計數器，不記 peerId / roomId / IP（隱私零負擔，無需 opt-in）。
 * - localStorage 持久化（跨 session 累積），環境無 localStorage 時
 *   自動退化為記憶體模式（Node 測試 / SSR 安全）。
 * - 語義：counts 記「轉換次數」非「連線數」——同一連線斷後重連會
 *   各記一次，rates 因此是事件率非配對率（P0 精度足夠，文件如實）。
 */

const STORAGE_KEY = 'nerilo.connStats.v1';

export interface ConnectionStatsSnapshot {
  /** P2P 連線嘗試（P2PConnectionManager.initialize） */
  attempts: number;
  /** 進入 connected 的轉換次數 */
  connected: number;
  /** 定案 failed 的轉換次數（ICE restart 重試後仍失敗才計） */
  failed: number;
  /** ICE restart 嘗試次數 */
  iceRestarts: number;
  /** ICE restart 後成功恢復次數 */
  iceRestartRecovered: number;
  /** 經 Firestore fallback 送出的訊息數 */
  fallbackMessages: number;
  /** 直連成功率（connected / attempts，attempts=0 時為 null） */
  directSuccessRate: number | null;
  /** restart 救援率（recovered / iceRestarts，0 時為 null） */
  restartRecoveryRate: number | null;
  /** 統計起始時間（首次記錄時間戳） */
  since: number | null;
}

type Counters = Omit<ConnectionStatsSnapshot, 'directSuccessRate' | 'restartRecoveryRate'>;

const ZERO: Counters = {
  attempts: 0,
  connected: 0,
  failed: 0,
  iceRestarts: 0,
  iceRestartRecovered: 0,
  fallbackMessages: 0,
  since: null,
};

function hasLocalStorage(): boolean {
  try {
    return typeof localStorage !== 'undefined' && localStorage !== null;
  } catch {
    return false;
  }
}

function load(): Counters {
  if (!hasLocalStorage()) return { ...ZERO };
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...ZERO };
    const parsed = JSON.parse(raw) as Partial<Counters>;
    return { ...ZERO, ...parsed };
  } catch {
    return { ...ZERO };
  }
}

function save(c: Counters): void {
  if (!hasLocalStorage()) return;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(c));
  } catch {
    /* 容量滿等情況：靜默放棄持久化，記憶體模式繼續 */
  }
}

class ConnectionStats {
  private counters: Counters = load();

  private bump(key: keyof Omit<Counters, 'since'>): void {
    if (this.counters.since === null) this.counters.since = Date.now();
    this.counters[key] += 1;
    save(this.counters);
  }

  recordAttempt(): void {
    this.bump('attempts');
  }

  recordConnected(): void {
    this.bump('connected');
  }

  recordFailed(): void {
    this.bump('failed');
  }

  recordIceRestart(): void {
    this.bump('iceRestarts');
  }

  recordIceRestartRecovered(): void {
    this.bump('iceRestartRecovered');
  }

  recordFallbackMessage(): void {
    this.bump('fallbackMessages');
  }

  getSnapshot(): ConnectionStatsSnapshot {
    const c = this.counters;
    return {
      ...c,
      directSuccessRate: c.attempts > 0 ? c.connected / c.attempts : null,
      restartRecoveryRate: c.iceRestarts > 0 ? c.iceRestartRecovered / c.iceRestarts : null,
    };
  }

  /** 歸零（測試/使用者要求清除） */
  reset(): void {
    this.counters = { ...ZERO };
    save(this.counters);
  }

  /** 重新從 storage 載入（測試用） */
  reload(): void {
    this.counters = load();
  }
}

/** 全域單例：P2PConnectionManager 與 FirestoreChatFallback 直接呼叫 */
export const connectionStats = new ConnectionStats();
