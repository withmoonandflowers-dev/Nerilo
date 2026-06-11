/**
 * NetworkSyncManager — P2P 確定性同步管理器
 *
 * 結合 InputBuffer 與 World，實現 Lockstep + Rollback 的網路同步。
 *
 * 運作流程：
 *   1. 每個 tick 開始前，檢查所有玩家的輸入是否齊全
 *   2. 輸入齊全 → 正常推進模擬（confirmed tick）
 *   3. 輸入未齊全 → 用預測輸入先跑（predicted tick），標記為未確認
 *   4. 遲到的輸入到達後，比對預測是否正確
 *   5. 預測錯誤 → 回溯到最後確認的 tick，用正確輸入重新模擬
 *
 * 適用場景：
 *   - 2-8 人即時對戰（格鬥、射擊、賽車等）
 *   - 需要確定性的回合制遊戲
 *   - P2P 架構下無中央伺服器的同步
 */

import { logger } from '../../utils/logger';
import type { PlayerInput, WorldSnapshot } from './types';
import { World } from './World';
import { InputBuffer } from './InputBuffer';

/** NetworkSync 組態 */
export interface NetworkSyncConfig {
  /** 最大可容忍的預測 tick 數（超過就暫停等待，預設 8） */
  maxPredictionAhead: number;
  /** 快照保留數量（供回溯使用，預設 30） */
  maxSnapshots: number;
  /** 每個 tick 結束後是否自動產生狀態雜湊（用於驗證，預設 true） */
  enableStateHash: boolean;
}

const DEFAULT_SYNC_CONFIG: NetworkSyncConfig = {
  maxPredictionAhead: 8,
  maxSnapshots: 30,
  enableStateHash: true,
};

/** 同步狀態指標 */
export interface SyncStatus {
  /** 最後一個所有輸入都確認到齊的 tick */
  confirmedTick: number;
  /** 目前模擬推進到的 tick（含預測） */
  currentTick: number;
  /** 目前領先確認 tick 多少（currentTick - confirmedTick） */
  predictionAhead: number;
  /** 是否因為預測太多而暫停中 */
  isWaiting: boolean;
  /** 已執行的回溯次數（debug 用） */
  rollbackCount: number;
}

/** 回溯事件（供外部監聽） */
export interface RollbackEvent {
  /** 回溯到哪個 tick */
  toTick: number;
  /** 從哪個 tick 回溯 */
  fromTick: number;
  /** 因為哪個 peer 的輸入造成的 */
  triggerPeerId: string;
  /** 重新模擬了幾個 tick */
  resimulatedTicks: number;
}

export type RollbackHandler = (event: RollbackEvent) => void;

export class NetworkSyncManager {
  private world: World;
  private inputBuffer: InputBuffer;
  private config: NetworkSyncConfig;

  /** 最後確認（所有輸入到齊）的 tick */
  private confirmedTick = -1;

  /** 歷史快照（用於回溯） */
  private snapshots = new Map<number, WorldSnapshot>();

  /** 每個 tick 的狀態雜湊（用於跨節點驗證） */
  private stateHashes = new Map<number, string>();

  /** 回溯計數 */
  private rollbackCount = 0;

  /** 回溯事件監聽器 */
  private rollbackHandlers = new Set<RollbackHandler>();

  constructor(
    world: World,
    inputBuffer: InputBuffer,
    config?: Partial<NetworkSyncConfig>,
  ) {
    this.world = world;
    this.inputBuffer = inputBuffer;
    this.config = { ...DEFAULT_SYNC_CONFIG, ...config };
  }

  // ── 核心同步流程 ─────────────────────────────────────────────────────

  /**
   * 嘗試推進模擬一個 tick。
   *
   * @param dt 固定時間步長（秒）
   * @returns 是否成功推進（false 表示因等待輸入而暫停）
   */
  advanceTick(dt: number): boolean {
    const nextTick = this.world.getCurrentTick();

    // 檢查是否已經預測太多 tick → 暫停等待遠端輸入
    if (nextTick - this.confirmedTick > this.config.maxPredictionAhead) {
      logger.info('[NetworkSyncManager] 等待中：預測過多', {
        nextTick,
        confirmedTick: this.confirmedTick,
        ahead: nextTick - this.confirmedTick,
      });
      return false;
    }

    // 在推進前拍快照（供回溯用）
    this.saveSnapshot(nextTick);

    // 檢查這個 tick 的輸入是否齊全
    if (this.inputBuffer.isTickReady(nextTick)) {
      // 所有輸入到齊 → confirmed tick
      this.confirmedTick = nextTick;
    }
    // 無論齊不齊全，都推進模擬（缺的用預測補上）

    // 執行一個 tick
    this.world.tick(dt);

    // 產生狀態雜湊
    if (this.config.enableStateHash) {
      this.stateHashes.set(nextTick, this.computeStateHash());
    }

    // 淘汰舊快照
    this.evictOldSnapshots();

    return true;
  }

  /**
   * 當遲到的遠端輸入到達時呼叫。
   * 檢查是否需要回溯，如果需要就執行 rollback + resim。
   *
   * @returns 是否觸發了回溯
   */
  onRemoteInputReceived(input: PlayerInput): boolean {
    const inputTick = input.tick;
    const currentTick = this.world.getCurrentTick();

    // 如果這個輸入的 tick 已經被模擬過（且是預測的） → 需要回溯
    if (inputTick < currentTick) {
      // 先取出當時的預測（在存入實際輸入之前）
      const predicted = this.inputBuffer.getOrPredict(inputTick, input.peerId);
      const mismatch = this.inputMismatch(predicted, input);

      // 再存入實際輸入
      this.inputBuffer.addRemoteInput(input);

      if (mismatch) {
        this.rollback(inputTick, currentTick, input.peerId);
        return true;
      }
    } else {
      // 尚未模擬到的 tick → 直接存入
      this.inputBuffer.addRemoteInput(input);
    }

    // 更新 confirmedTick
    this.updateConfirmedTick();

    return false;
  }

  // ── 回溯機制 ─────────────────────────────────────────────────────────

  /**
   * 回溯到指定 tick，然後用正確的輸入重新模擬到現在。
   */
  private rollback(toTick: number, fromTick: number, triggerPeerId: string): void {
    // 找到最近的快照（<= toTick）
    const snapshot = this.findNearestSnapshot(toTick);
    if (!snapshot) {
      logger.warn('[NetworkSyncManager] 回溯失敗：找不到快照', {
        toTick,
        fromTick,
        snapshotKeys: [...this.snapshots.keys()],
      });
      return;
    }

    this.rollbackCount++;

    logger.info('[NetworkSyncManager] 執行回溯', {
      snapshotTick: snapshot.tick,
      toTick,
      fromTick,
      triggerPeerId,
    });

    // 還原快照
    this.world.restoreSnapshot(snapshot);

    // 重新模擬從快照 tick 到 fromTick
    const dt = this.world.getDeltaTime();
    const ticksToResim = fromTick - snapshot.tick;

    for (let i = 0; i < ticksToResim; i++) {
      const tick = snapshot.tick + i;

      // 更新快照（重新模擬後的正確狀態）
      this.saveSnapshot(tick);

      this.world.tick(dt);

      if (this.config.enableStateHash) {
        this.stateHashes.set(tick, this.computeStateHash());
      }
    }

    // 通知監聽器
    const event: RollbackEvent = {
      toTick: snapshot.tick,
      fromTick,
      triggerPeerId,
      resimulatedTicks: ticksToResim,
    };
    for (const handler of this.rollbackHandlers) {
      try { handler(event); } catch { /* ignore */ }
    }
  }

  // ── 狀態雜湊 ─────────────────────────────────────────────────────────

  /**
   * 計算目前 World 的狀態雜湊。
   * 所有節點如果狀態一致，雜湊應該相同。
   * 使用簡易 JSON 序列化 + 字串雜湊（非加密用途，只求一致性）。
   */
  private computeStateHash(): string {
    const snapshot = this.world.takeSnapshot();
    // 排序 entities 確保確定性
    snapshot.entities.sort((a, b) => a.id - b.id);
    const json = JSON.stringify(snapshot.entities);
    return this.simpleHash(json);
  }

  /**
   * FNV-1a 32-bit 雜湊（快速、非加密用途）
   */
  private simpleHash(str: string): string {
    let hash = 0x811c9dc5;
    for (let i = 0; i < str.length; i++) {
      hash ^= str.charCodeAt(i);
      hash = (hash * 0x01000193) | 0;
    }
    return (hash >>> 0).toString(16).padStart(8, '0');
  }

  /**
   * 取得指定 tick 的狀態雜湊（供跨節點比對）。
   */
  getStateHash(tick: number): string | undefined {
    return this.stateHashes.get(tick);
  }

  /**
   * 比對本機與遠端的狀態雜湊。
   * @returns true 表示一致，false 表示不一致（可能有作弊或 bug）
   */
  verifyStateHash(tick: number, remoteHash: string): boolean {
    const localHash = this.stateHashes.get(tick);
    if (!localHash) return false;
    return localHash === remoteHash;
  }

  // ── 狀態查詢 ─────────────────────────────────────────────────────────

  /** 取得同步狀態 */
  getSyncStatus(): SyncStatus {
    const currentTick = this.world.getCurrentTick();
    const predictionAhead = currentTick - this.confirmedTick;
    return {
      confirmedTick: this.confirmedTick,
      currentTick,
      predictionAhead,
      isWaiting: predictionAhead > this.config.maxPredictionAhead,
      rollbackCount: this.rollbackCount,
    };
  }

  /** 監聽回溯事件 */
  onRollback(handler: RollbackHandler): () => void {
    this.rollbackHandlers.add(handler);
    return () => { this.rollbackHandlers.delete(handler); };
  }

  /** 清空所有狀態 */
  destroy(): void {
    this.snapshots.clear();
    this.stateHashes.clear();
    this.rollbackHandlers.clear();
    this.confirmedTick = -1;
    this.rollbackCount = 0;
  }

  // ── 內部方法 ─────────────────────────────────────────────────────────

  private saveSnapshot(tick: number): void {
    if (!this.snapshots.has(tick)) {
      this.snapshots.set(tick, this.world.takeSnapshot());
    }
  }

  private findNearestSnapshot(tick: number): WorldSnapshot | undefined {
    // 往回找最近的快照（<= tick）
    let best: WorldSnapshot | undefined;
    for (const [t, snap] of this.snapshots) {
      if (t <= tick && (!best || t > best.tick)) {
        best = snap;
      }
    }
    return best;
  }

  private evictOldSnapshots(): void {
    while (this.snapshots.size > this.config.maxSnapshots) {
      let minTick: number | null = null;
      for (const t of this.snapshots.keys()) {
        if (minTick === null || t < minTick) minTick = t;
      }
      if (minTick !== null) {
        this.snapshots.delete(minTick);
        this.stateHashes.delete(minTick);
      } else {
        break;
      }
    }
  }

  private updateConfirmedTick(): void {
    // 從 confirmedTick+1 開始，看能往前推多少
    let tick = this.confirmedTick + 1;
    while (tick < this.world.getCurrentTick() && this.inputBuffer.isTickReady(tick)) {
      this.confirmedTick = tick;
      tick++;
    }
  }

  private inputMismatch(predicted: PlayerInput, actual: PlayerInput): boolean {
    // 比較 actions
    if (predicted.actions.length !== actual.actions.length) return true;
    const sortedPred = [...predicted.actions].sort();
    const sortedActual = [...actual.actions].sort();
    for (let i = 0; i < sortedPred.length; i++) {
      if (sortedPred[i] !== sortedActual[i]) return true;
    }

    // 比較 axes
    const predKeys = Object.keys(predicted.axes).sort();
    const actualKeys = Object.keys(actual.axes).sort();
    if (predKeys.length !== actualKeys.length) return true;
    for (let i = 0; i < predKeys.length; i++) {
      if (predKeys[i] !== actualKeys[i]) return true;
      if (predicted.axes[predKeys[i]] !== actual.axes[actualKeys[i]]) return true;
    }

    return false;
  }
}
