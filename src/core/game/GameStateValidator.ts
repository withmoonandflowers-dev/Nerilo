/**
 * GameStateValidator — 跨節點狀態驗證與作弊偵測
 *
 * 在 P2P 架構下，沒有中央伺服器可以仲裁。
 * 取而代之的是「多數決 + 雜湊比對」的去中心化驗證。
 *
 * 驗證流程：
 *   1. 每 N 個 tick（驗證間隔），各節點廣播自己的狀態雜湊
 *   2. 收集所有節點的雜湊後進行比對
 *   3. 多數一致 → 正常
 *   4. 有節點雜湊不同 → 標記為可疑（desync），可能是 bug 或作弊
 *   5. 連續 K 次 desync → 觸發踢出投票或強制重新同步
 *
 * 這個模組不依賴特定的網路傳輸層，只處理雜湊的收集與比對邏輯。
 */

import { logger } from '../../utils/logger';

/** Validator 組態 */
export interface ValidatorConfig {
  /** 每隔幾個 tick 做一次驗證（預設 20，等於 20Hz 下每秒一次） */
  validationInterval: number;
  /** 連續幾次 desync 才觸發警報（預設 3） */
  desyncThreshold: number;
  /** 雜湊記錄最多保留幾筆（預設 100） */
  maxHashHistory: number;
  /** 驗證結果過期時間（tick 數，預設 200） */
  resultExpiry: number;
}

const DEFAULT_VALIDATOR_CONFIG: ValidatorConfig = {
  validationInterval: 20,
  desyncThreshold: 3,
  maxHashHistory: 100,
  resultExpiry: 200,
};

/** 單次驗證結果 */
export interface ValidationResult {
  tick: number;
  /** 是否所有節點一致 */
  consistent: boolean;
  /** 多數決的雜湊值 */
  majorityHash: string;
  /** 各節點的雜湊 */
  peerHashes: Map<string, string>;
  /** 與多數不一致的節點 */
  desyncedPeers: string[];
}

/** Desync 事件 */
export interface DesyncEvent {
  peerId: string;
  tick: number;
  expectedHash: string;
  actualHash: string;
  consecutiveDesyncs: number;
}

export type DesyncHandler = (event: DesyncEvent) => void;
export type DesyncAlertHandler = (peerId: string, consecutiveDesyncs: number) => void;

export class GameStateValidator {
  private config: ValidatorConfig;

  /** tick → peerId → hash */
  private hashRecords = new Map<number, Map<string, string>>();

  /** 驗證結果歷史 */
  private results = new Map<number, ValidationResult>();

  /** 每個 peer 的連續 desync 次數 */
  private consecutiveDesyncs = new Map<string, number>();

  /** 已知的所有 peer */
  private knownPeers = new Set<string>();

  /** 本機 peer ID */
  private localId: string;

  /** 事件監聽 */
  private desyncHandlers = new Set<DesyncHandler>();
  private alertHandlers = new Set<DesyncAlertHandler>();

  constructor(localId: string, config?: Partial<ValidatorConfig>) {
    this.localId = localId;
    this.config = { ...DEFAULT_VALIDATOR_CONFIG, ...config };
  }

  // ── Peer 管理 ─────────────────────────────────────────────────────────

  addPeer(peerId: string): void {
    this.knownPeers.add(peerId);
  }

  removePeer(peerId: string): void {
    this.knownPeers.delete(peerId);
    this.consecutiveDesyncs.delete(peerId);
  }

  // ── 雜湊收集 ─────────────────────────────────────────────────────────

  /**
   * 判斷指定 tick 是否需要驗證。
   */
  shouldValidate(tick: number): boolean {
    return tick > 0 && tick % this.config.validationInterval === 0;
  }

  /**
   * 提交本機的狀態雜湊。
   */
  submitLocalHash(tick: number, hash: string): void {
    this.submitHash(tick, this.localId, hash);
  }

  /**
   * 提交遠端 peer 的狀態雜湊。
   */
  submitHash(tick: number, peerId: string, hash: string): void {
    let tickHashes = this.hashRecords.get(tick);
    if (!tickHashes) {
      tickHashes = new Map();
      this.hashRecords.set(tick, tickHashes);
    }
    tickHashes.set(peerId, hash);

    // 檢查是否所有 peer 的雜湊都到齊了
    if (this.isTickHashesComplete(tick)) {
      this.validateTick(tick);
    }
  }

  /**
   * 判斷某個 tick 的雜湊是否齊全。
   */
  isTickHashesComplete(tick: number): boolean {
    const tickHashes = this.hashRecords.get(tick);
    if (!tickHashes) return false;

    // 需要本機 + 所有已知 peer
    if (!tickHashes.has(this.localId)) return false;
    for (const peerId of this.knownPeers) {
      if (!tickHashes.has(peerId)) return false;
    }
    return true;
  }

  // ── 驗證邏輯 ─────────────────────────────────────────────────────────

  /**
   * 對指定 tick 進行多數決驗證。
   */
  validateTick(tick: number): ValidationResult {
    const tickHashes = this.hashRecords.get(tick);
    if (!tickHashes || tickHashes.size === 0) {
      const result: ValidationResult = {
        tick,
        consistent: true,
        majorityHash: '',
        peerHashes: new Map(),
        desyncedPeers: [],
      };
      this.results.set(tick, result);
      return result;
    }

    // 計算多數決
    const hashCounts = new Map<string, number>();
    for (const hash of tickHashes.values()) {
      hashCounts.set(hash, (hashCounts.get(hash) ?? 0) + 1);
    }

    // 找出最多人使用的雜湊
    let majorityHash = '';
    let maxCount = 0;
    for (const [hash, count] of hashCounts) {
      if (count > maxCount) {
        maxCount = count;
        majorityHash = hash;
      }
    }

    // 找出不一致的 peer
    const desyncedPeers: string[] = [];
    for (const [peerId, hash] of tickHashes) {
      if (hash !== majorityHash) {
        desyncedPeers.push(peerId);
      }
    }

    const result: ValidationResult = {
      tick,
      consistent: desyncedPeers.length === 0,
      majorityHash,
      peerHashes: new Map(tickHashes),
      desyncedPeers,
    };

    this.results.set(tick, result);

    // 處理 desync
    if (desyncedPeers.length > 0) {
      this.handleDesyncs(tick, majorityHash, tickHashes, desyncedPeers);
    } else {
      // 所有一致 → 重置所有 peer 的連續 desync 計數
      for (const peerId of tickHashes.keys()) {
        this.consecutiveDesyncs.set(peerId, 0);
      }
    }

    // 淘汰舊記錄
    this.evictOld(tick);

    return result;
  }

  // ── 查詢 ──────────────────────────────────────────────────────────────

  /** 取得指定 tick 的驗證結果 */
  getResult(tick: number): ValidationResult | undefined {
    return this.results.get(tick);
  }

  /** 取得某個 peer 的連續 desync 次數 */
  getConsecutiveDesyncs(peerId: string): number {
    return this.consecutiveDesyncs.get(peerId) ?? 0;
  }

  /** 取得所有已知的可疑 peer（連續 desync >= threshold） */
  getSuspiciousPeers(): string[] {
    const suspicious: string[] = [];
    for (const [peerId, count] of this.consecutiveDesyncs) {
      if (count >= this.config.desyncThreshold) {
        suspicious.push(peerId);
      }
    }
    return suspicious;
  }

  // ── 事件監聽 ─────────────────────────────────────────────────────────

  /** 監聽每次 desync 事件 */
  onDesync(handler: DesyncHandler): () => void {
    this.desyncHandlers.add(handler);
    return () => { this.desyncHandlers.delete(handler); };
  }

  /** 監聽 desync 達到門檻的警報 */
  onDesyncAlert(handler: DesyncAlertHandler): () => void {
    this.alertHandlers.add(handler);
    return () => { this.alertHandlers.delete(handler); };
  }

  /** 清空所有狀態 */
  destroy(): void {
    this.hashRecords.clear();
    this.results.clear();
    this.consecutiveDesyncs.clear();
    this.knownPeers.clear();
    this.desyncHandlers.clear();
    this.alertHandlers.clear();
  }

  // ── 內部 ──────────────────────────────────────────────────────────────

  private handleDesyncs(
    tick: number,
    majorityHash: string,
    tickHashes: Map<string, string>,
    desyncedPeers: string[],
  ): void {
    for (const peerId of desyncedPeers) {
      const count = (this.consecutiveDesyncs.get(peerId) ?? 0) + 1;
      this.consecutiveDesyncs.set(peerId, count);

      const event: DesyncEvent = {
        peerId,
        tick,
        expectedHash: majorityHash,
        actualHash: tickHashes.get(peerId)!,
        consecutiveDesyncs: count,
      };

      logger.warn('[GameStateValidator] Desync 偵測', {
        peerId,
        tick,
        consecutive: count,
      });

      // 通知 desync 監聽器
      for (const handler of this.desyncHandlers) {
        try { handler(event); } catch { /* ignore */ }
      }

      // 如果達到門檻，觸發警報
      if (count >= this.config.desyncThreshold) {
        logger.warn('[GameStateValidator] Desync 警報！', {
          peerId,
          consecutiveDesyncs: count,
        });
        for (const handler of this.alertHandlers) {
          try { handler(peerId, count); } catch { /* ignore */ }
        }
      }
    }

    // 一致的 peer 重置計數
    for (const [peerId, hash] of tickHashes) {
      if (hash === majorityHash) {
        this.consecutiveDesyncs.set(peerId, 0);
      }
    }
  }

  private evictOld(currentTick: number): void {
    const expiry = currentTick - this.config.resultExpiry;
    for (const tick of this.hashRecords.keys()) {
      if (tick < expiry) {
        this.hashRecords.delete(tick);
        this.results.delete(tick);
      }
    }
    // 額外限制 hashRecords 大小
    while (this.hashRecords.size > this.config.maxHashHistory) {
      const oldest = [...this.hashRecords.keys()].sort((a, b) => a - b)[0];
      this.hashRecords.delete(oldest);
      this.results.delete(oldest);
    }
  }
}
