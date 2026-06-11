/**
 * InputBuffer — 玩家輸入緩衝佇列
 *
 * 在 P2P 網路遊戲中，每個節點需要收集所有玩家在每個 tick 的輸入，
 * 才能進行確定性模擬。InputBuffer 負責：
 *
 *   1. 收集本機玩家輸入（滑鼠 / 鍵盤 / 手把）
 *   2. 快取遠端玩家透過 WebRTC DataChannel 傳來的輸入
 *   3. 提供「某個 tick 的所有玩家輸入是否齊全」的查詢
 *   4. 當遠端輸入遲到時，用最近一次已知輸入做預測（input prediction）
 *   5. 保留歷史輸入供回溯（rollback）使用
 *
 * 設計重點：
 *   - 環形緩衝區，固定大小，自動淘汰過舊的 tick
 *   - per-peer 追蹤，支援任意數量的玩家
 *   - 執行緒安全（單執行緒 JS 不需鎖，但資料結構設計上避免競態）
 */

import type { PlayerInput } from './types';

/** InputBuffer 組態 */
export interface InputBufferConfig {
  /** 緩衝區保留多少個 tick 的歷史（預設 128） */
  bufferSize: number;
  /** 輸入延遲（delay ticks）：本機輸入延遲幾個 tick 才生效，讓遠端有時間傳送（預設 2） */
  inputDelay: number;
  /** 當遠端輸入缺失時，最多用前幾個 tick 的輸入做預測（預設 5） */
  maxPredictionTicks: number;
}

const DEFAULT_CONFIG: InputBufferConfig = {
  bufferSize: 128,
  inputDelay: 2,
  maxPredictionTicks: 5,
};

/** 空輸入（無按鍵、無軸） */
const EMPTY_INPUT: Omit<PlayerInput, 'peerId' | 'tick' | 'seq'> = {
  actions: [],
  axes: {},
};

export class InputBuffer {
  private config: InputBufferConfig;

  /**
   * 主儲存結構：tick → peerId → PlayerInput
   * 用 Map 而非陣列，因為 tick 可能不連續（回溯後跳號）
   */
  private buffer = new Map<number, Map<string, PlayerInput>>();

  /** 已知的所有玩家 ID（用來判斷某 tick 的輸入是否齊全） */
  private knownPeers = new Set<string>();

  /** 每個 peer 最近一次收到的輸入（用於預測） */
  private lastKnownInput = new Map<string, PlayerInput>();

  /** 本機 seq 計數器 */
  private localSeq = 0;

  constructor(config?: Partial<InputBufferConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  // ── 玩家管理 ─────────────────────────────────────────────────────────

  /** 註冊一個玩家（加入遊戲時呼叫） */
  addPeer(peerId: string): void {
    this.knownPeers.add(peerId);
  }

  /** 移除一個玩家（離開遊戲時呼叫） */
  removePeer(peerId: string): void {
    this.knownPeers.delete(peerId);
    this.lastKnownInput.delete(peerId);
  }

  /** 取得目前已註冊的玩家數量 */
  getPeerCount(): number {
    return this.knownPeers.size;
  }

  // ── 輸入寫入 ─────────────────────────────────────────────────────────

  /**
   * 寫入本機玩家的輸入。
   * 會自動加上 inputDelay：實際生效的 tick = currentTick + inputDelay。
   *
   * @returns 包含生效 tick 的完整 PlayerInput（可直接廣播給其他節點）
   */
  addLocalInput(
    peerId: string,
    currentTick: number,
    actions: string[],
    axes: Record<string, number> = {},
  ): PlayerInput {
    const effectiveTick = currentTick + this.config.inputDelay;
    const input: PlayerInput = {
      peerId,
      tick: effectiveTick,
      actions: [...actions],
      axes: { ...axes },
      seq: ++this.localSeq,
    };

    this.storeInput(input);
    return input;
  }

  /**
   * 寫入遠端玩家透過網路傳來的輸入。
   * 直接儲存，不加 delay（遠端節點在送出前已經加過了）。
   */
  addRemoteInput(input: PlayerInput): void {
    this.storeInput(input);
  }

  // ── 輸入讀取 ─────────────────────────────────────────────────────────

  /**
   * 取得某個 tick 中，某位玩家的輸入。
   * 如果該 tick 沒有收到，回傳 undefined。
   */
  getInput(tick: number, peerId: string): PlayerInput | undefined {
    return this.buffer.get(tick)?.get(peerId);
  }

  /**
   * 取得某個 tick 所有已收到的輸入（不含預測）。
   */
  getInputsForTick(tick: number): Map<string, PlayerInput> {
    return this.buffer.get(tick) ?? new Map();
  }

  /**
   * 判斷某個 tick 的所有已註冊玩家輸入是否齊全（全部到齊）。
   */
  isTickReady(tick: number): boolean {
    const tickInputs = this.buffer.get(tick);
    if (!tickInputs) return this.knownPeers.size === 0;

    for (const peerId of this.knownPeers) {
      if (!tickInputs.has(peerId)) return false;
    }
    return true;
  }

  /**
   * 取得某個 tick 中還缺哪些玩家的輸入。
   */
  getMissingPeers(tick: number): string[] {
    const tickInputs = this.buffer.get(tick);
    const missing: string[] = [];
    for (const peerId of this.knownPeers) {
      if (!tickInputs?.has(peerId)) {
        missing.push(peerId);
      }
    }
    return missing;
  }

  /**
   * 取得某位玩家在某個 tick 的輸入，如果缺失則用預測補上。
   * 預測邏輯：往前找最近 maxPredictionTicks 個 tick，取最近的輸入。
   * 如果完全沒有歷史，回傳空輸入。
   */
  getOrPredict(tick: number, peerId: string): PlayerInput {
    // 先看有沒有確切的輸入
    const exact = this.getInput(tick, peerId);
    if (exact) return exact;

    // 往前找最近的輸入（input prediction）
    for (let t = tick - 1; t >= tick - this.config.maxPredictionTicks && t >= 0; t--) {
      const prev = this.buffer.get(t)?.get(peerId);
      if (prev) {
        return { ...prev, tick, seq: -1 }; // seq = -1 表示是預測的
      }
    }

    // 用最後已知輸入
    const last = this.lastKnownInput.get(peerId);
    if (last) {
      return { ...last, tick, seq: -1 };
    }

    // 完全沒有歷史 → 空輸入
    return {
      peerId,
      tick,
      seq: -1,
      ...EMPTY_INPUT,
    };
  }

  /**
   * 判斷某個輸入是否為預測產生的（seq === -1）。
   */
  isPredicted(input: PlayerInput): boolean {
    return input.seq === -1;
  }

  // ── 歷史管理 ─────────────────────────────────────────────────────────

  /**
   * 清除指定 tick 以前（不含）的所有歷史輸入。
   * 通常在確認某個 tick 已同步完畢後呼叫，釋放記憶體。
   */
  discardBefore(tick: number): void {
    for (const t of this.buffer.keys()) {
      if (t < tick) {
        this.buffer.delete(t);
      }
    }
  }

  /** 取得緩衝區中最舊的 tick */
  getOldestTick(): number | null {
    let min: number | null = null;
    for (const t of this.buffer.keys()) {
      if (min === null || t < min) min = t;
    }
    return min;
  }

  /** 取得緩衝區中最新的 tick */
  getNewestTick(): number | null {
    let max: number | null = null;
    for (const t of this.buffer.keys()) {
      if (max === null || t > max) max = t;
    }
    return max;
  }

  /** 取得目前緩衝區佔用的 tick 數量 */
  getBufferedTickCount(): number {
    return this.buffer.size;
  }

  /** 清空所有狀態 */
  clear(): void {
    this.buffer.clear();
    this.lastKnownInput.clear();
    this.localSeq = 0;
  }

  /** 清空所有狀態並移除所有玩家 */
  destroy(): void {
    this.clear();
    this.knownPeers.clear();
  }

  // ── 內部方法 ─────────────────────────────────────────────────────────

  private storeInput(input: PlayerInput): void {
    const { tick, peerId } = input;

    // 取得或建立該 tick 的儲存空間
    let tickInputs = this.buffer.get(tick);
    if (!tickInputs) {
      tickInputs = new Map();
      this.buffer.set(tick, tickInputs);
    }

    // 如果已經有同一個 tick + peerId 的輸入，用 seq 較大的覆蓋
    const existing = tickInputs.get(peerId);
    if (existing && existing.seq >= input.seq) {
      return; // 舊的或重複的，忽略
    }

    tickInputs.set(peerId, input);

    // 更新 lastKnownInput（用於預測）
    const lastKnown = this.lastKnownInput.get(peerId);
    if (!lastKnown || input.tick > lastKnown.tick) {
      this.lastKnownInput.set(peerId, input);
    }

    // 淘汰過舊的 tick（環形緩衝區概念）
    this.evictOld();
  }

  private evictOld(): void {
    while (this.buffer.size > this.config.bufferSize) {
      // 刪掉最小的 tick
      let minTick: number | null = null;
      for (const t of this.buffer.keys()) {
        if (minTick === null || t < minTick) minTick = t;
      }
      if (minTick !== null) {
        this.buffer.delete(minTick);
      } else {
        break;
      }
    }
  }
}
