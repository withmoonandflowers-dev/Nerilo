import { computePayloadHash, computeEntryHash, isPlainObject, isHex64 } from '../../utils/crypto';
import type { LedgerEntry, SharedStreamPayload, SharedStreamConfig } from '../../types';

const DEFAULT_GENESIS_PREVIOUS_HASH = '0';
const DEFAULT_MAX_PAYLOAD_SIZE = 100_000;
const DEFAULT_MAX_ENTRIES = 50_000;
const DEFAULT_APPEND_RATE_PER_SECOND = 20;
const HASH_LEN = 64;

/**
 * 共享資料流（區塊鏈式）
 * 維護不可竄改的順序日誌，透過 hash 鏈驗證完整性，並可透過廣播（Gossip）與其他節點同步。
 * 具備 payload 大小、條目數、append 速率等限制以確保效能與安全。
 */
export class SharedDataStream {
  private entries: LedgerEntry[] = [];
  private config: Required<
    Pick<
      SharedStreamConfig,
      'roomId' | 'creatorId' | 'genesisPreviousHash' | 'maxPayloadSize' | 'maxEntries' | 'appendRateLimitPerSecond' | 'hashHexLength'
    >
  >;
  private entryListeners: Set<(entry: LedgerEntry) => void> = new Set();
  /** 當有本地新條目時呼叫，由呼叫方負責透過 Gossip 廣播 */
  private onBroadcast: ((entry: LedgerEntry) => void) | null = null;
  private seenEntryHashes: Set<string> = new Set();
  private readonly MAX_SEEN_SIZE = 5000;
  /** append 速率限制：最近 N 筆 append 的時間戳 */
  private appendTimestamps: number[] = [];

  /**
   * Freeze 狀態：merge / split 期間禁止本地新 append，避免鏈血統混亂。
   * 外部透過 freeze() / unfreeze() 控制；handleReceivedEntry 不受影響（
   * 遠端條目仍可接收，只有本地發起的 append 被阻擋）。
   *
   * 整合邊界說明
   * ─────────────────────────────────────────────────────
   * SharedDataStream  = Gossip 廣播傳輸層 + 記憶體內鏈存儲（有速率、大小、freeze 保護）
   *                     由 ChainSyncService 管理；每個 peer 各自持有一份實例。
   *
   * SharedLedgerEngine = Fork 偵測解決 + Snapshot 分析層（無廣播邏輯）
   *                     可選性地包裹 SharedDataStream 的輸出；
   *                     在收到遠端條目後呼叫 SharedLedgerEngine.append()
   *                     進行 fork 偵測，並透過 onFork 回呼通知上層處理。
   * ─────────────────────────────────────────────────────
   */
  private frozen = false;

  constructor(config: SharedStreamConfig) {
    this.config = {
      genesisPreviousHash: DEFAULT_GENESIS_PREVIOUS_HASH,
      maxPayloadSize: config.maxPayloadSize ?? DEFAULT_MAX_PAYLOAD_SIZE,
      maxEntries: config.maxEntries ?? DEFAULT_MAX_ENTRIES,
      appendRateLimitPerSecond: config.appendRateLimitPerSecond ?? DEFAULT_APPEND_RATE_PER_SECOND,
      hashHexLength: config.hashHexLength ?? HASH_LEN,
      roomId: config.roomId,
      creatorId: config.creatorId,
    };
  }

  /**
   * 設定廣播回呼（例如接到 Mesh Gossip 的 send）
   */
  setBroadcastHandler(handler: (entry: LedgerEntry) => void): void {
    this.onBroadcast = handler;
  }

  // ── Freeze / Unfreeze（Merge / Split 保護） ─────────────────────────────

  /**
   * 凍結鏈：禁止本地新增條目，直到 unfreeze()。
   * 應在 merge / split 請求被接受後立即呼叫，完成後再呼叫 unfreeze()。
   * 遠端收到的條目（handleReceivedEntry）不受影響。
   */
  freeze(): void {
    this.frozen = true;
    console.log('[SharedDataStream] Frozen — local appends blocked', { roomId: this.config.roomId });
  }

  /**
   * 解凍鏈：恢復允許本地新增條目。
   * merge / split 完成後呼叫。
   */
  unfreeze(): void {
    this.frozen = false;
    console.log('[SharedDataStream] Unfrozen — local appends resumed', { roomId: this.config.roomId });
  }

  /** 目前是否處於凍結狀態 */
  isFrozen(): boolean {
    return this.frozen;
  }

  /**
   * 取得目前所有條目（唯讀）
   */
  getEntries(): readonly LedgerEntry[] {
    return this.entries;
  }

  /**
   * 取得最後一筆條目
   */
  getLastEntry(): LedgerEntry | null {
    return this.entries.length > 0 ? this.entries[this.entries.length - 1]! : null;
  }

  /**
   * 取得前一筆的 hash（創世時用 genesisPreviousHash）
   */
  private getPreviousHash(): string {
    const last = this.getLastEntry();
    return last ? last.entryHash : (this.config.genesisPreviousHash ?? DEFAULT_GENESIS_PREVIOUS_HASH);
  }

  /**
   * 檢查 append 速率是否超過限制
   */
  private checkAppendRate(): boolean {
    const now = Date.now();
    const windowStart = now - 1000;
    this.appendTimestamps = this.appendTimestamps.filter((t) => t > windowStart);
    return this.appendTimestamps.length < this.config.appendRateLimitPerSecond;
  }

  /**
   * 附加一筆新條目到本地鏈，並可觸發廣播
   * 會驗證 payload 為純物件、大小、條目數上限與 append 速率。
   * 若鏈處於凍結狀態（freeze()），本地 append 將拋出錯誤。
   */
  async append(payload: SharedStreamPayload): Promise<LedgerEntry> {
    // Merge / Split freeze guard — only block local appends
    if (this.frozen) {
      throw new Error(
        '[SharedDataStream] append blocked: stream is frozen during merge/split operation. ' +
        'Call unfreeze() after the operation completes.'
      );
    }
    if (!isPlainObject(payload)) {
      throw new TypeError('SharedDataStream.append: payload must be a plain object');
    }
    if (this.entries.length >= this.config.maxEntries) {
      throw new Error(
        `SharedDataStream.append: max entries reached (${this.config.maxEntries})`
      );
    }
    if (!this.checkAppendRate()) {
      throw new Error('SharedDataStream.append: append rate limit exceeded');
    }

    this.appendTimestamps.push(Date.now());

    const previousHash = this.getPreviousHash();
    const index = this.entries.length;
    const timestamp = Date.now();
    const payloadHash = await computePayloadHash(payload, this.config.maxPayloadSize);

    const entryWithoutHash: Omit<LedgerEntry, 'entryHash'> = {
      index,
      previousHash,
      payloadHash,
      timestamp,
      creatorId: this.config.creatorId,
      payload,
    };

    const entryHash = await computeEntryHash({
      previousHash,
      index,
      timestamp,
      payloadHash,
      creatorId: this.config.creatorId,
    });

    const entry: LedgerEntry = { ...entryWithoutHash, entryHash };

    this.entries.push(entry);
    this.seenEntryHashes.add(entryHash);
    this.cleanupSeenHashes();
    this.notifyListeners(entry);

    if (this.onBroadcast) {
      try {
        this.onBroadcast(entry);
      } catch (err) {
        console.warn('[SharedDataStream] Broadcast handler error', { roomId: this.config.roomId, error: err });
      }
    }

    return entry;
  }

  /**
   * 驗證收到的 entry 結構與 hash 格式（不驗證鏈銜接）
   */
  private validateEntryShape(entry: LedgerEntry): boolean {
    if (
      typeof entry.index !== 'number' ||
      !Number.isInteger(entry.index) ||
      entry.index < 0
    ) {
      return false;
    }
    if (
      typeof entry.timestamp !== 'number' ||
      !Number.isInteger(entry.timestamp) ||
      entry.timestamp < 0
    ) {
      return false;
    }
    if (typeof entry.creatorId !== 'string' || entry.creatorId.length === 0) {
      return false;
    }
    if (!isPlainObject(entry.payload)) {
      return false;
    }
    if (!isHex64(entry.entryHash) || !isHex64(entry.payloadHash)) {
      return false;
    }
    if (typeof entry.previousHash !== 'string') {
      return false;
    }
    return true;
  }

  /**
   * 處理從其他節點收到的條目：驗證 hash 鏈與 payloadHash，通過則附加並可轉發
   */
  async handleReceivedEntry(entry: LedgerEntry): Promise<boolean> {
    if (!this.validateEntryShape(entry)) {
      console.warn('[SharedDataStream] Invalid entry shape', { roomId: this.config.roomId, index: entry?.index });
      return false;
    }
    if (this.entries.length >= this.config.maxEntries) {
      return false; // 已達上限，拒絕新條目
    }
    if (this.seenEntryHashes.has(entry.entryHash)) {
      return false; // 已處理過
    }

    // 驗證 entryHash 是否與宣告一致
    const expectedHash = await computeEntryHash({
      previousHash: entry.previousHash,
      index: entry.index,
      timestamp: entry.timestamp,
      payloadHash: entry.payloadHash,
      creatorId: entry.creatorId,
    });
    if (expectedHash !== entry.entryHash) {
      console.warn('[SharedDataStream] Invalid entryHash', { roomId: this.config.roomId, index: entry.index });
      return false;
    }

    // 驗證 hash 鏈：前一筆必須是本地最後一筆
    const last = this.getLastEntry();
    const expectedPrevious = last ? last.entryHash : (this.config.genesisPreviousHash ?? DEFAULT_GENESIS_PREVIOUS_HASH);
    if (entry.previousHash !== expectedPrevious) {
      // 可選：若 index 大於本地長度，可先緩存待補齊前序條目（本實作先拒絕）
      console.warn('[SharedDataStream] Chain mismatch (previousHash)', {
        roomId: this.config.roomId,
        index: entry.index,
        expectedPrevious: expectedPrevious.slice(0, 16),
        got: entry.previousHash.slice(0, 16),
      });
      return false;
    }

    // 驗證 index 連續
    if (entry.index !== this.entries.length) {
      console.warn('[SharedDataStream] Index mismatch', {
        roomId: this.config.roomId,
        expected: this.entries.length,
        got: entry.index,
      });
      return false;
    }

    // 驗證 payloadHash（含 payload 大小限制）
    let payloadHash: string;
    try {
      payloadHash = await computePayloadHash(entry.payload as Record<string, unknown>, this.config.maxPayloadSize);
    } catch (err) {
      console.warn('[SharedDataStream] Payload hash error (e.g. oversized)', {
        roomId: this.config.roomId,
        index: entry.index,
        error: err,
      });
      return false;
    }
    if (payloadHash !== entry.payloadHash) {
      console.warn('[SharedDataStream] Invalid payloadHash', { roomId: this.config.roomId, index: entry.index });
      return false;
    }

    this.entries.push(entry);
    this.seenEntryHashes.add(entry.entryHash);
    this.cleanupSeenHashes();
    this.notifyListeners(entry);

    // 可選：再轉發給鄰居（若上層在 Gossip 層已做轉發則可省略）
    if (this.onBroadcast) {
      try {
        this.onBroadcast(entry);
      } catch (_) {
        // 轉發失敗不影響已寫入本地
      }
    }

    return true;
  }

  /**
   * 訂閱新條目（本地附加或收到並驗證通過的條目）
   */
  onEntryAppended(listener: (entry: LedgerEntry) => void): () => void {
    this.entryListeners.add(listener);
    return () => {
      this.entryListeners.delete(listener);
    };
  }

  private notifyListeners(entry: LedgerEntry): void {
    this.entryListeners.forEach((fn) => {
      try {
        fn(entry);
      } catch (err) {
        console.error('[SharedDataStream] Listener error', { roomId: this.config.roomId, error: err });
      }
    });
  }

  private cleanupSeenHashes(): void {
    if (this.seenEntryHashes.size <= this.MAX_SEEN_SIZE) return;
    const hashes = Array.from(this.seenEntryHashes);
    const toKeep = new Set(hashes.slice(-this.MAX_SEEN_SIZE / 2));
    this.seenEntryHashes = toKeep;
  }

  /** 允許一次 reset 的最大遠端條目數，避免 DoS */
  private static readonly MAX_RESET_ENTRIES = 100_000;

  /**
   * 從一組條目還原本地鏈（例如 catch-up 時從鄰居拉取整條鏈）
   * 會驗證整條鏈的 hash 銜接與 payloadHash，通過則取代目前 entries
   * 遠端條目數不得超過 MAX_RESET_ENTRIES。
   */
  async resetFromEntries(remoteEntries: LedgerEntry[]): Promise<boolean> {
    // Freeze guard — 與 append() 一致，凍結期間拒絕重設，防止惡意 peer 繞過 merge 保護
    if (this.frozen) {
      console.warn('[SharedDataStream] resetFromEntries blocked: stream is frozen during merge/split', {
        roomId: this.config.roomId,
      });
      return false;
    }
    if (!Array.isArray(remoteEntries) || remoteEntries.length === 0) {
      return false;
    }
    if (remoteEntries.length > SharedDataStream.MAX_RESET_ENTRIES) {
      console.warn('[SharedDataStream] resetFromEntries: too many entries', {
        roomId: this.config.roomId,
        count: remoteEntries.length,
        max: SharedDataStream.MAX_RESET_ENTRIES,
      });
      return false;
    }
    if (remoteEntries.length > this.config.maxEntries) {
      return false; // 超過本地允許的 maxEntries
    }

    const genesis = this.config.genesisPreviousHash ?? DEFAULT_GENESIS_PREVIOUS_HASH;
    for (let i = 0; i < remoteEntries.length; i++) {
      const entry = remoteEntries[i]!;
      if (!this.validateEntryShape(entry)) return false;
      const prev = i === 0 ? genesis : remoteEntries[i - 1]!.entryHash;
      if (entry.previousHash !== prev) return false;
      if (entry.index !== i) return false;

      const expectedHash = await computeEntryHash({
        previousHash: entry.previousHash,
        index: entry.index,
        timestamp: entry.timestamp,
        payloadHash: entry.payloadHash,
        creatorId: entry.creatorId,
      });
      if (expectedHash !== entry.entryHash) return false;

      try {
        const payloadHash = await computePayloadHash(entry.payload as Record<string, unknown>, this.config.maxPayloadSize);
        if (payloadHash !== entry.payloadHash) return false;
      } catch {
        return false; // 例如 payload 過大
      }
    }

    this.entries = [...remoteEntries];
    remoteEntries.forEach((e) => this.seenEntryHashes.add(e.entryHash));
    this.cleanupSeenHashes();
    return true;
  }
}
