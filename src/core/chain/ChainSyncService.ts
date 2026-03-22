import type { LedgerEntry } from '../../types';
import type { ChainMergeMessage } from './ChainMergeService';
import { SharedDataStream } from '../mesh/SharedDataStream';
import { indexedDBService } from '../../services/IndexedDBService';

// ── P2P 主鏈同步訊息格式 ─────────────────────────────────────────────────────

/** 新加入的 peer 向既有 peer 請求帳本主鏈 */
interface ChainSyncRequest {
  type: 'chain-sync:request';
  /** 請求者目前已有的最後一筆 index（-1 代表空鏈）*/
  lastKnownIndex: number;
}

/** 既有 peer 回覆帳本主鏈 */
interface ChainSyncResponse {
  type: 'chain-sync:response';
  entries: LedgerEntry[];
}

export type ChainSyncMessage =
  | ChainSyncRequest
  | ChainSyncResponse
  | ChainMergeMessage; // provenance 相關訊息由 ChainMergeService 處理

/** 發送函式型別：由上層（P2PManager / DataChannel）提供 */
export type ChainSyncSendFn = (peerId: string, message: ChainSyncMessage) => void;

// ── ChainSyncService ─────────────────────────────────────────────────────────

/**
 * 區塊鏈帳本同步服務（主鏈）
 *
 * 職責：
 * 1. 橋接 SharedDataStream（記憶體）↔ IndexedDB（持久化）
 *    - 每次 SharedDataStream 新增條目 → 自動寫入 IndexedDB
 *    - 進入房間時從 IndexedDB 還原既有主鏈
 * 2. P2P 主鏈同步協議（chain-sync:request / response）
 *    - 新 peer 加入時請求完整主鏈，既有 peer 回覆
 * 3. Provenance 訊息轉發給 ChainMergeService
 *    - 連線建立後宣告 provenance（announce）
 *    - 處理 provenance-request / response
 * 4. 房間隔離
 *    - 離開或切換房間時，清除 IndexedDB 中該房間的主鏈條目
 *
 * 使用方式：
 * ```ts
 * const chainSync = new ChainSyncService({ roomId, stream, sendFn, mergeService? });
 * await chainSync.initialize();    // 從 IndexedDB 還原主鏈
 * chainSync.onPeerConnected(peerId); // 新 peer 連線：請求主鏈 + 宣告 provenance
 * chainSync.handleMessage(fromPeerId, message); // 處理任何 chain-sync 訊息
 * await chainSync.dispose();       // 離開房間時清理
 * ```
 */
export class ChainSyncService {
  private readonly roomId: string;
  private readonly stream: SharedDataStream;
  private readonly sendFn: ChainSyncSendFn;
  /** 選填：若本房間有合併/分岔，提供 ChainMergeService 處理 provenance 訊息 */
  private mergeService: import('./ChainMergeService').ChainMergeService | null = null;
  private unsubscribeStream: (() => void) | null = null;

  constructor(config: {
    roomId: string;
    stream: SharedDataStream;
    sendFn: ChainSyncSendFn;
  }) {
    this.roomId = config.roomId;
    this.stream = config.stream;
    this.sendFn = config.sendFn;
  }

  /**
   * 注入 ChainMergeService（選填）
   * 設定後，provenance 相關 P2P 訊息會轉交給它處理
   */
  setMergeService(
    service: import('./ChainMergeService').ChainMergeService
  ): void {
    this.mergeService = service;
  }

  /**
   * 初始化：從 IndexedDB 還原本地主鏈，並開始監聽新條目以持久化
   */
  async initialize(): Promise<void> {
    // 1. 從 IndexedDB 載入既有主鏈
    const savedEntries = await indexedDBService.getChainEntries(this.roomId);
    if (savedEntries.length > 0) {
      const ok = await this.stream.resetFromEntries(savedEntries);
      if (ok) {
        console.log('[ChainSyncService] Restored chain from IndexedDB', {
          roomId: this.roomId,
          entries: savedEntries.length,
        });
      } else {
        console.warn('[ChainSyncService] Local chain validation failed, clearing IndexedDB', {
          roomId: this.roomId,
        });
        await indexedDBService.clearChainEntries(this.roomId);
      }
    }

    // 2. 監聽新條目，自動持久化
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
   * 新 peer 連線時呼叫：
   * 1. 向對方請求主鏈（若我比對方短或是空鏈）
   * 2. 宣告本地擁有的 provenance（若有）
   */
  async onPeerConnected(peerId: string): Promise<void> {
    // 1. 請求主鏈
    this.requestChainFromPeer(peerId);

    // 2. 宣告 provenance（若有 mergeService）
    if (this.mergeService) {
      await this.mergeService.announceProvenanceToPeer(peerId);
    }
  }

  /**
   * 向既有 peer 請求主鏈（新加入時呼叫）
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
   * 處理來自 DataChannel 的所有 chain-sync 訊息
   * - chain-sync:request / response → 主鏈同步
   * - chain-sync:provenance-* → 轉交給 ChainMergeService
   */
  async handleMessage(fromPeerId: string, message: ChainSyncMessage): Promise<void> {
    switch (message.type) {
      case 'chain-sync:request':
        await this.handleSyncRequest(fromPeerId, message);
        break;
      case 'chain-sync:response':
        await this.handleSyncResponse(fromPeerId, message);
        break;
      case 'chain-sync:provenance-announce':
      case 'chain-sync:provenance-request':
      case 'chain-sync:provenance-response':
        if (this.mergeService) {
          await this.mergeService.handleMessage(fromPeerId, message as ChainMergeMessage);
        } else {
          console.log('[ChainSyncService] Received provenance message but no mergeService set', {
            roomId: this.roomId,
            type: message.type,
          });
        }
        break;
      default:
        console.warn('[ChainSyncService] Unknown message type', {
          roomId: this.roomId,
          type: (message as any).type,
        });
    }
  }

  // ── 私有：處理主鏈同步請求 ──────────────────────────────────────────────

  private async handleSyncRequest(
    fromPeerId: string,
    request: ChainSyncRequest
  ): Promise<void> {
    const allEntries = this.stream.getEntries() as LedgerEntry[];
    if (allEntries.length === 0) return;

    const startIndex = request.lastKnownIndex + 1;
    // 若對方是空鏈，傳完整鏈；否則只傳對方沒有的部分
    const entriesToSend =
      request.lastKnownIndex === -1
        ? allEntries
        : allEntries.filter((e) => e.index >= startIndex);

    if (entriesToSend.length === 0) return;

    const response: ChainSyncResponse = {
      type: 'chain-sync:response',
      entries: entriesToSend,
    };

    console.log('[ChainSyncService] Sending chain to peer', {
      roomId: this.roomId,
      fromPeerId,
      entriesCount: response.entries.length,
    });

    this.sendFn(fromPeerId, response);
  }

  // ── 私有：處理主鏈同步回覆 ──────────────────────────────────────────────

  private async handleSyncResponse(
    fromPeerId: string,
    response: ChainSyncResponse
  ): Promise<void> {
    if (!response.entries || response.entries.length === 0) return;

    const currentLength = this.stream.getEntries().length;

    if (currentLength > 0 && response.entries[0]?.index !== 0) {
      // 增量：逐條加入
      for (const entry of response.entries) {
        await this.stream.handleReceivedEntry(entry);
      }
    } else {
      // 完整鏈：resetFromEntries 整體驗證
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

    // 持久化到 IndexedDB
    for (const entry of response.entries) {
      try {
        await indexedDBService.saveChainEntry(entry, this.roomId);
      } catch (err) {
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
   * 離開房間時呼叫：停止監聽並清除本房間的 IndexedDB 主鏈資料
   *
   * @param clearChain 是否同時清除 IndexedDB 資料（預設 true）
   *                   若要保留歷史（例如分岔後 A 的成員要帶走 A 的鏈），可傳 false
   */
  async dispose(clearChain = true): Promise<void> {
    if (this.unsubscribeStream) {
      this.unsubscribeStream();
      this.unsubscribeStream = null;
    }

    if (clearChain) {
      await indexedDBService.clearChainEntries(this.roomId);
      console.log('[ChainSyncService] Main chain cleared on dispose', {
        roomId: this.roomId,
      });
    }
  }
}
