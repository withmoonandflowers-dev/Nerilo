/**
 * 信使品質的本地觀測庫（Spec 028 §9.3.2）。
 *
 * 只保存本節點量到的連線與對帳結果，不讀取對端自報的 capacity 或 metrics，
 * 也不把分數寫進 directory 或任何線上訊息。預設單例只涵蓋目前頁面生命週期；
 * 是否跨重載保存仍是 C-Q3，不能在此先假設。
 */

export interface CourierQualitySnapshot {
  courierUid: string;
  connectionAttempts: number;
  connectionSuccesses: number;
  lastConnectionSucceeded: boolean | null;
  lastConnectionLatencyMs: number | null;
  reconcileAttempts: number;
  reconcileSuccesses: number;
  lastReconcileSucceeded: boolean | null;
  reachableSinceMs: number | null;
  lastReachableAtMs: number | null;
  continuousReachableMs: number;
  consecutiveFailures: number;
  score: number;
}

type MutableCourierQuality = Omit<CourierQualitySnapshot, 'continuousReachableMs' | 'score'>;

export class CourierQualityStore {
  private readonly records = new Map<string, MutableCourierQuality>();

  constructor(private readonly clock: () => number = Date.now) {}

  nowMs(): number {
    return this.clock();
  }

  recordConnection(courierUid: string, succeeded: boolean, latencyMs: number): void {
    const record = this.getOrCreate(courierUid);
    record.connectionAttempts += 1;
    if (succeeded) record.connectionSuccesses += 1;
    record.lastConnectionSucceeded = succeeded;
    record.lastConnectionLatencyMs = Math.max(0, latencyMs);
    record.lastReconcileSucceeded = null;
    if (succeeded) this.recordReachable(record);
    else this.recordFailure(record);
  }

  recordReconcile(courierUid: string, succeeded: boolean): void {
    const record = this.getOrCreate(courierUid);
    record.reconcileAttempts += 1;
    if (succeeded) record.reconcileSuccesses += 1;
    record.lastReconcileSucceeded = succeeded;
    if (succeeded) this.recordReachable(record);
    else this.recordFailure(record);
  }

  get(courierUid: string): CourierQualitySnapshot | undefined {
    const record = this.records.get(courierUid);
    return record ? this.snapshot(record) : undefined;
  }

  getScore(courierUid: string): number {
    const record = this.records.get(courierUid);
    return record ? this.score(record) : 0;
  }

  /** 未觀測候選為中性 0；同分以原始 index 保持 directory 順序。 */
  rankCandidates(courierUids: string[]): string[] {
    return courierUids
      .map((courierUid, index) => ({ courierUid, index, score: this.getScore(courierUid) }))
      .sort((a, b) => b.score - a.score || a.index - b.index)
      .map(({ courierUid }) => courierUid);
  }

  clear(): void {
    this.records.clear();
  }

  private getOrCreate(courierUid: string): MutableCourierQuality {
    const existing = this.records.get(courierUid);
    if (existing) return existing;
    const created: MutableCourierQuality = {
      courierUid,
      connectionAttempts: 0,
      connectionSuccesses: 0,
      lastConnectionSucceeded: null,
      lastConnectionLatencyMs: null,
      reconcileAttempts: 0,
      reconcileSuccesses: 0,
      lastReconcileSucceeded: null,
      reachableSinceMs: null,
      lastReachableAtMs: null,
      consecutiveFailures: 0,
    };
    this.records.set(courierUid, created);
    return created;
  }

  private recordReachable(record: MutableCourierQuality): void {
    const now = this.clock();
    if (record.reachableSinceMs === null) record.reachableSinceMs = now;
    record.lastReachableAtMs = now;
    record.consecutiveFailures = 0;
  }

  private recordFailure(record: MutableCourierQuality): void {
    record.reachableSinceMs = null;
    record.lastReachableAtMs = null;
    record.consecutiveFailures += 1;
  }

  private snapshot(record: MutableCourierQuality): CourierQualitySnapshot {
    const continuousReachableMs = record.reachableSinceMs === null || record.lastReachableAtMs === null
      ? 0
      : Math.max(0, record.lastReachableAtMs - record.reachableSinceMs);
    return { ...record, continuousReachableMs, score: this.score(record) };
  }

  private score(record: MutableCourierQuality): number {
    // 成敗率以 0.5 為中性；對帳比連線權重高，因為連上但無法完成補收仍不可用。
    const connection = record.connectionAttempts === 0
      ? 0
      : (record.connectionSuccesses / record.connectionAttempts - 0.5) * 40;
    const reconcile = record.reconcileAttempts === 0
      ? 0
      : (record.reconcileSuccesses / record.reconcileAttempts - 0.5) * 60;
    // 延遲與連續可達只作同級候選的有限加分，不可蓋過實際失敗。
    const latency = record.lastConnectionSucceeded && record.lastConnectionLatencyMs !== null
      ? 10 / (1 + record.lastConnectionLatencyMs / 1_000)
      : 0;
    const reachableMs = record.reachableSinceMs === null || record.lastReachableAtMs === null
      ? 0
      : Math.max(0, record.lastReachableAtMs - record.reachableSinceMs);
    const reachability = Math.min(reachableMs / 3_600_000, 1) * 10;
    const failurePenalty = Math.min(record.consecutiveFailures * 10, 30);
    return Math.max(-100, Math.min(100, connection + reconcile + latency + reachability - failurePenalty));
  }
}

export const defaultCourierQualityStore = new CourierQualityStore();
