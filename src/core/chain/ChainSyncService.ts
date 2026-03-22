import type { LedgerEntry } from '../../types';
import { SharedDataStream } from '../mesh/SharedDataStream';
import { indexedDBService } from '../../services/IndexedDBService';

// ── P2P 訊息格式（透過 DataChannel 傳送）────────────────────────────────────

/** 新加入的 peer 向既有 peer 請求帳本鏈 */
interface ChainSyncRequest {
  type: 'chain-sync:request';
  /** 請求者目前已有的最後一筆 index（-1 代表空鏈）*/
  lastKnownIndex: number;
}

/** 既有 peer 回覆帳本鏈 */
interface ChainSyncResponse {
  type: 'chain-sync:response';
  /** 完整鏈條目（依 index 排序）*/
  entries: LedgerEntry[];
}

export type ChainSyncMessage = ChainSyncRequest | ChainSyncResponse;

/** 發送函式型別：由上層（P2PManager / DataChannel）提供 */
export type ChainSyncSendFn = (peerId: string, message: ChainSyncMessage) => void;

// ── ChainSyncService ─────────────────────────────────────────────────────────

/**
 * 區塊鏈帳本同步服務
 *
 * 職責：
 * 1. 橋接 SharedDataStream（記憶體）↔ IndexedDB（持久化）
 *    - 每次 SharedDataStream 新增條目 → 自動寫入 IndexedDB
 *    - 進入房間時從 IndexedDB 還原既有鏈
 * 2. P2P 新加入同步協議
 *    - 新 peer 連線時，向既有 peer 發送 chain-sync:request
 *    - 既有 peer 收到請求，回覆 chain-sync:response（完整鏈）
 *    - 收到 response 後呼叫 SharedDataStream.resetFromEntries()
 * 3. 房間隔離
 *    - 離開或切換房間時，清除 IndexedDB 中該房間的鏈條目
 *
 * 使用方式：
 * ```ts
 * const chainSync = new ChainSyncService({ roomId, stream, sendFn });
 * await chainSync.initialize(); // 從 IndexedDB 還原鏈
 *
 * // 當本地 peer 新加入房間（想要追上現有鏈）
 * chainSync.requestChainFromPeer(existingPeerId);
 *
 * // 當收到 DataChannel 訊息時
 * chainSync.handleMessage(fromPeerId, message);
 *
 * // 離開房間時
 * await chainSync.dispose();
 * ```
 */
export class ChainSyncService {
  private readonly roomId: string;
  private readonly stream: SharedDataStream;
  private readonly sendFn: ChainSyncSendFn;
  private unsubscribeStream: (() => void) | null = null;

  constructor(config: {
    roomId: string;
    stream: SharedDataStream;
    /**
     * 透過 DataChannel 傳送訊息的函式
     * 由上層（P2PManager / MultiP2PManager）注入
     */
    sendFn: ChainSyncSendFn;
  }) {
    this.roomId = config.roomId;
    this.stream = config.stream;
    this.sendFn = config.sendFn;
  }

  /**
   * 初始化：從 IndexedDB 還原本地鏈，並開始監聽新條目以持久化
   *
   * 應在進入房間且 SharedDataStream 建立後呼叫。
   */
  async initialize(): Promise<void> {
    // 1. 從 IndexedDB 載入既有帳本鏈
    const savedEntries = await indexedDBService.getChainEntries(this.roomId);
    if (savedEntries.length > 0) {
      const ok = await this.stream.resetFromEntries(savedEntries);
      if (ok) {
        console.log('[ChainSyncService] Restored chain from IndexedDB', {
          roomId: this.roomId,
          entries: savedEntries.length,
        });
      } else {
        // 本地鏈驗證失敗（可能是舊資料損壞），清除後重新開始
        console.warn('[ChainSyncService] Local chain validation failed, clearing IndexedDB', {
          roomId: this.roomId,
        });
        await indexedDBService.clearChainEntries(this.roomId);
      }
    }

    // 2. 監聽新條目，自動持久化到 IndexedDB
    this.unsubscribeStream = this.stream.onEntryAppended(async (entry) => {
      try {
        await indexedDBService.saveChainEntry(entry, this.roomId);
      } catch (err) {
        console.error('[ChainSyncService] Failed to persist chain entry', {
          roomId: this.roomId,
          index: entry.index,
          error: err,
        });
      }
    });

    console.log('[ChainSyncService] Initialized', {
      roomId: this.roomId,
      localChainLength: this.stream.getEntries().length,
    });
  }

  /**
   * 向既有 peer 發送鏈同步請求（新加入時呼叫）
   *
   * @param targetPeerId 目標 peer 的 ID（DataChannel 識別碼）
   */
  requestChainFromPeer(targetPeerId: string): void {
    const lastEntry = this.stream.getLastEntry();
    const request: ChainSyncRequest = {
      type: 'chain-sync:request',
      lastKnownIndex: lastEntry ? lastEntry.index : -1,
    };

    console.log('[ChainSyncService] Requesting chain from peer', {
      roomId: this.roomId,
      targetPeerId,
      lastKnownIndex: request.lastKnownIndex,
    });

    this.sendFn(targetPeerId, request);
  }

  /**
   * 處理來自 DataChannel 的 chain-sync 訊息
   *
   * @param fromPeerId 發送者的 peer ID
   * @param message    收到的訊息（需先確認是 chain-sync 命名空間）
   */
  async handleMessage(fromPeerId: string, message: ChainSyncMessage): Promise<void> {
    if (message.type === 'chain-sync:request') {
      await this.handleSyncRequest(fromPeerId, message);
    } else if (message.type === 'chain-sync:response') {
      await this.handleSyncResponse(fromPeerId, message);
    }
  }

  // ── 私有：處理同步請求（我是既有 peer） ────────────────────────────────────

  private async handleSyncRequest(
    fromPeerId: string,
    request: ChainSyncRequest
  ): Promise<void> {
    const allEntries = this.stream.getEntries() as LedgerEntry[];

    if (allEntries.length === 0) {
      // 我也沒有鏈，不回覆
      console.log('[ChainSyncService] No entries to send, skipping', {
        roomId: this.roomId,
        fromPeerId,
      });
      return;
    }

    // 只傳送對方尚未擁有的部分（lastKnownIndex + 1 以後的）
    const startIndex = request.lastKnownIndex + 1;
    const entriesToSend = startIndex > 0
      ? allEntries.filter((e) => e.index >= startIndex)
      : allEntries;

    if (entriesToSend.length === 0) {
      console.log('[ChainSyncService] Peer is already up to date', {
        roomId: this.roomId,
        fromPeerId,
        lastKnownIndex: request.lastKnownIndex,
      });
      return;
    }

    const response: ChainSyncResponse = {
      type: 'chain-sync:response',
      // 注意：resetFromEntries 需要完整鏈，所以若對方鏈不是空的，
      // 我們傳完整鏈讓它做完整驗證
      entries: request.lastKnownIndex === -1 ? allEntries : entriesToSend,
    };

    console.log('[ChainSyncService] Sending chain to peer', {
      roomId: this.roomId,
      fromPeerId,
      entriesCount: response.entries.length,
    });

    this.sendFn(fromPeerId, response);
  }

  // ── 私有：處理同步回覆（我是新加入的 peer）────────────────────────────────

  private async handleSyncResponse(
    fromPeerId: string,
    response: ChainSyncResponse
  ): Promise<void> {
    if (!response.entries || response.entries.length === 0) return;

    const currentLength = this.stream.getEntries().length;

    if (currentLength > 0 && response.entries[0]?.index !== 0) {
      // 對方只傳了部分鏈（增量），逐條加入
      for (const entry of response.entries) {
        await this.stream.handleReceivedEntry(entry);
      }
    } else {
      // 對方傳了完整鏈，用 resetFromEntries 整體驗證後取代
      const ok = await this.stream.resetFromEntries(response.entries);
      if (!ok) {
        console.warn('[ChainSyncService] resetFromEntries failed (invalid remote chain)', {
          roomId: this.roomId,
          fromPeerId,
          entriesCount: response.entries.length,
        });
        return;
      }
    }

    // 將新收到的條目也持久化到 IndexedDB
    for (const entry of response.entries) {
      try {
        await indexedDBService.saveChainEntry(entry, this.roomId);
      } catch (err) {
        // 忽略重複寫入錯誤（saveChainEntry 已做了去重判斷）
        console.warn('[ChainSyncService] Persist error (may be duplicate)', {
          roomId: this.roomId,
          index: entry.index,
          error: err,
        });
      }
    }

    console.log('[ChainSyncService] Chain synced from peer', {
      roomId: this.roomId,
      fromPeerId,
      newLength: this.stream.getEntries().length,
    });
  }

  // ── 離開/銷毀 ─────────────────────────────────────────────────────────────

  /**
   * 離開房間時呼叫：停止監聽並清除本房間的 IndexedDB 鏈資料
   *
   * 注意：不清除其他表（chats、files、events），只清除帳本鏈。
   * 若需要清除整個房間資料，請呼叫 indexedDBService.clearRoomData()。
   */
  async dispose(clearChain = true): Promise<void> {
    if (this.unsubscribeStream) {
      this.unsubscribeStream();
      this.unsubscribeStream = null;
    }

    if (clearChain) {
      await indexedDBService.clearChainEntries(this.roomId);
      console.log('[ChainSyncService] Chain cleared on dispose', {
        roomId: this.roomId,
      });
    }
  }
}
