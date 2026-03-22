/**
 * ChainMergeService — 房間合併/分岔時的區塊鏈帳本處理
 *
 * ════════════════════════════════════════════════════════════════════════════
 * 核心設計原則：Hash 鏈不可重新索引
 * ════════════════════════════════════════════════════════════════════════════
 *
 * SHA-256 hash 鏈的每一筆 entryHash 包含 index：
 *   entryHash = SHA256(previousHash | index | timestamp | payloadHash | creatorId)
 *
 * 若重新索引（reindex），index 改變 → entryHash 改變 → 整條鏈全部失效。
 * 因此**不能**把 Room A 的條目重新索引後接在 Room B 的鏈後面。
 *
 * ════════════════════════════════════════════════════════════════════════════
 * 解決方案：Provenance 雙鏈視圖
 * ════════════════════════════════════════════════════════════════════════════
 *
 *  ┌─────────────────────────────────────────────────────────────┐
 *  │  Room B 的「完整歷史」= 主鏈 ∪ Provenance 鏈                │
 *  │                                                             │
 *  │  主鏈（Room B 自身）：hash 鏈完整，index 連續               │
 *  │    [B0]─[B1]─[B2]─[MERGE_MARKER]─[B3]─[B4]                │
 *  │                                                             │
 *  │  Provenance 鏈（來自 Room A）：hash 鏈完整，獨立 index      │
 *  │    [A0]─[A1]─[A2]─[A3]                                     │
 *  │                                                             │
 *  │  顯示時：兩鏈依 timestamp 交叉排序 → 完整時間線             │
 *  └─────────────────────────────────────────────────────────────┘
 *
 * ════════════════════════════════════════════════════════════════════════════
 * Merge 流程（Room A → Room B）
 * ════════════════════════════════════════════════════════════════════════════
 *
 *  1. Room B owner 接受 merge：
 *     a. 寫入 MERGE_MARKER 到 Room B 主鏈
 *        payload: { _type:'room:merged', sourceRoomId:'A', mergedAt, sourceOwnerUid }
 *     b. （若 B owner 有 A 的鏈）儲存 A 的鏈作為 B 的 provenance
 *
 *  2. Room A 的成員連進 Room B（P2P）：
 *     a. 宣告自己有 provenance：chain-sync:provenance-announce
 *        [{ sourceRoomId:'A', operation:'merge', entryCount:4, lastHash:'...' }]
 *     b. Room B 成員若沒有此 provenance，發出 chain-sync:provenance-request
 *     c. Room A 成員回應 chain-sync:provenance-response，傳送完整 A 鏈
 *     d. 接收方驗證後儲存為 provenance
 *
 * ════════════════════════════════════════════════════════════════════════════
 * Split 流程（Room A → A' + B）
 * ════════════════════════════════════════════════════════════════════════════
 *
 *  1. 新 Room B owner（本身在 Room A）接受 split：
 *     a. 取得自己 IndexedDB 裡 Room A 的鏈（本人在 A，所以有完整鏈）
 *     b. 寫入 SPLIT_FROM_MARKER 作為 Room B 主鏈第一筆
 *        payload: { _type:'room:split_from', sourceRoomId:'A', splitAt, sourceChainLength }
 *     c. 儲存 Room A 的鏈作為 Room B 的 provenance（截至 split 時刻）
 *
 *  2. Room A owner 偵測到 split completed：
 *     a. 寫入 SPLIT_TO_MARKER 到 Room A 主鏈
 *        payload: { _type:'room:split_to', targetRoomId:'B', targetParticipants, splitAt }
 *
 *  3. 其他 split 成員加入 Room B（P2P）：
 *     a. 他們也有 Room A 的鏈（之前在 A）
 *     b. 透過 provenance-announce/request/response 確保 Room B 所有成員都有 A 的 provenance
 *
 * ════════════════════════════════════════════════════════════════════════════
 * 邊界情境
 * ════════════════════════════════════════════════════════════════════════════
 *
 *  ① 空鏈合併：Room A 或 Room B 鏈為空 → 寫 marker 後不加 provenance
 *  ② maxEntries 限制：provenance 不計入主鏈 maxEntries，獨立存放
 *  ③ 合併時並發 append：主鏈 marker 之後繼續正常 append，不受影響
 *  ④ Provenance 重複：saveProvenanceEntries 有去重（by entryHash）
 *  ⑤ 連鎖合併：A 本身有 provenance（來自更早的合併）→ 也隨著傳遞
 *  ⑥ Split 後 B 再 merge 進 C：B 的 provenance（來自 A）也一起帶過去
 */

import type {
  LedgerEntry,
  ChainMergeMarkerPayload,
  ChainSplitFromMarkerPayload,
  ChainSplitToMarkerPayload,
  ChainProvenanceAnnounce,
  ChainProvenanceRequest,
  ChainProvenanceResponse,
  ChainProvenanceSummary,
  LedgerEntryWithProvenance,
} from '../../types';
import type { SharedDataStream } from '../mesh/SharedDataStream';
import type { IndexedDBService } from '../../services/IndexedDBService';

/** 所有 ChainMergeService 處理的 P2P 訊息型別 */
export type ChainMergeMessage =
  | ChainProvenanceAnnounce
  | ChainProvenanceRequest
  | ChainProvenanceResponse;

/** 發送函式：由上層（P2PManager / DataChannel）注入 */
export type ChainMergeSendFn = (peerId: string, message: ChainMergeMessage) => void;

// ── ChainMergeService ─────────────────────────────────────────────────────────

export class ChainMergeService {
  private readonly roomId: string;
  private readonly stream: SharedDataStream;
  private readonly db: IndexedDBService;
  private readonly sendFn: ChainMergeSendFn;

  constructor(config: {
    roomId: string;
    /** 本房間的 SharedDataStream（主鏈）*/
    stream: SharedDataStream;
    /** IndexedDB 服務（儲存 provenance）*/
    db: IndexedDBService;
    /**
     * DataChannel 發送函式
     * 由上層 P2PManager / MultiP2PManager 注入
     */
    sendFn: ChainMergeSendFn;
  }) {
    this.roomId = config.roomId;
    this.stream = config.stream;
    this.db = config.db;
    this.sendFn = config.sendFn;
  }

  // ══════════════════════════════════════════════════════════════════════════
  // MERGE — 合併標記 & Provenance 採納
  // ══════════════════════════════════════════════════════════════════════════

  /**
   * 寫入合併標記到本房間主鏈，並可選擇性地採納 source 鏈作為 provenance
   *
   * 呼叫時機：Room B owner 呼叫 acceptMergeRequest() 之後立刻呼叫
   *
   * @param sourceRoomId    Room A 的房間 ID
   * @param sourceOwnerUid  Room A 的房主 UID
   * @param sourceEntries   Room A 的完整鏈（若 B owner 本地有的話；通常為空，之後透過 P2P 同步）
   */
  async writeMergeMarker(
    sourceRoomId: string,
    sourceOwnerUid: string,
    sourceEntries: LedgerEntry[] = []
  ): Promise<LedgerEntry> {
    const markerPayload: ChainMergeMarkerPayload = {
      _type: 'room:merged',
      sourceRoomId,
      sourceOwnerUid,
      mergedAt: Date.now(),
    };

    const marker = await this.stream.append(markerPayload as unknown as Record<string, unknown>);

    // Marker 寫入後立即持久化到 DB（ChainSyncService 也會透過 onEntryAppended 寫入，有去重保護）
    await this.db.saveChainEntry(marker, this.roomId);

    // 若 B owner 已知道 A 的鏈（少見情境：B owner 也曾在 A 房間），立即儲存
    if (sourceEntries.length > 0) {
      await this.db.saveProvenanceEntries(
        sourceEntries,
        this.roomId,
        sourceRoomId,
        'merge'
      );
    }

    console.log('[ChainMergeService] Merge marker written', {
      roomId: this.roomId,
      sourceRoomId,
      markerIndex: marker.index,
      preloadedProvenanceCount: sourceEntries.length,
    });

    return marker;
  }

  /**
   * 接受來自 P2P 的 provenance 鏈並儲存（合併用）
   *
   * 通常在收到 chain-sync:provenance-response 後呼叫。
   *
   * @param sourceRoomId  原始房間 ID
   * @param entries       完整的 source 鏈條目（驗證後儲存）
   * @param operation     'merge' | 'split'
   */
  async adoptProvenanceChain(
    sourceRoomId: string,
    entries: LedgerEntry[],
    operation: 'merge' | 'split'
  ): Promise<boolean> {
    if (entries.length === 0) {
      console.warn('[ChainMergeService] adoptProvenanceChain: empty entries, skipping', {
        roomId: this.roomId,
        sourceRoomId,
      });
      return false;
    }

    // 基本驗證：index 連續性（不重算 hash，信任已通過 P2P 的條目）
    for (let i = 0; i < entries.length; i++) {
      if (entries[i]!.index !== i) {
        console.warn('[ChainMergeService] adoptProvenanceChain: index discontinuity', {
          roomId: this.roomId,
          sourceRoomId,
          expected: i,
          got: entries[i]!.index,
        });
        return false;
      }
    }

    await this.db.saveProvenanceEntries(entries, this.roomId, sourceRoomId, operation);

    console.log('[ChainMergeService] Provenance adopted', {
      roomId: this.roomId,
      sourceRoomId,
      operation,
      count: entries.length,
    });

    return true;
  }

  // ══════════════════════════════════════════════════════════════════════════
  // SPLIT — 分岔標記 & Provenance 建立
  // ══════════════════════════════════════════════════════════════════════════

  /**
   * 寫入「來自 Room A 分岔」的標記到本房間（Room B）主鏈第一筆，
   * 並立即採納 Room A 的鏈作為 Room B 的 provenance
   *
   * 呼叫時機：new Room B owner 在本地建立 Room B 之後立刻呼叫
   * 前提：呼叫者必須有 Room A 的完整鏈（因為他之前在 Room A）
   *
   * @param sourceRoomId    Room A 的房間 ID
   * @param sourceEntries   Room A 在分岔前的完整鏈條目
   */
  async writeSplitFromMarker(
    sourceRoomId: string,
    sourceEntries: LedgerEntry[]
  ): Promise<LedgerEntry> {
    const markerPayload: ChainSplitFromMarkerPayload = {
      _type: 'room:split_from',
      sourceRoomId,
      splitAt: Date.now(),
      sourceChainLength: sourceEntries.length,
    };

    const marker = await this.stream.append(markerPayload as unknown as Record<string, unknown>);

    // Marker 寫入後立即持久化到 DB
    await this.db.saveChainEntry(marker, this.roomId);

    // 立即採納 Room A 的鏈（new Room B owner 本人有完整鏈）
    if (sourceEntries.length > 0) {
      await this.db.saveProvenanceEntries(
        sourceEntries,
        this.roomId,
        sourceRoomId,
        'split'
      );
    }

    console.log('[ChainMergeService] SplitFrom marker written', {
      roomId: this.roomId,
      sourceRoomId,
      markerIndex: marker.index,
      provenanceCount: sourceEntries.length,
    });

    return marker;
  }

  /**
   * 寫入「Room B 已從我分岔出去」的標記到本房間（Room A）主鏈
   *
   * 呼叫時機：Room A owner 偵測到 split plan 狀態變為 'completed' 後呼叫
   */
  async writeSplitToMarker(
    targetRoomId: string,
    targetParticipants: string[]
  ): Promise<LedgerEntry> {
    const markerPayload: ChainSplitToMarkerPayload = {
      _type: 'room:split_to',
      targetRoomId,
      targetParticipants,
      splitAt: Date.now(),
    };

    const marker = await this.stream.append(markerPayload as unknown as Record<string, unknown>);

    // Marker 寫入後立即持久化到 DB
    await this.db.saveChainEntry(marker, this.roomId);

    console.log('[ChainMergeService] SplitTo marker written', {
      roomId: this.roomId,
      targetRoomId,
      markerIndex: marker.index,
      participants: targetParticipants,
    });

    return marker;
  }

  // ══════════════════════════════════════════════════════════════════════════
  // P2P Provenance 同步協議
  // ══════════════════════════════════════════════════════════════════════════

  /**
   * 向某個 peer 宣告本地有哪些 provenance 鏈
   * 在連線建立後呼叫（新 peer 加入時）
   */
  async announceProvenanceToPeer(peerId: string): Promise<void> {
    const provenanceMap = await this.db.getProvenanceEntries(this.roomId);
    if (provenanceMap.size === 0) return;

    const provenances: ChainProvenanceSummary[] = [];
    for (const [sourceRoomId, { operation, entries }] of provenanceMap) {
      if (entries.length === 0) continue;
      provenances.push({
        sourceRoomId,
        operation,
        entryCount: entries.length,
        lastHash: entries[entries.length - 1]!.entryHash,
      });
    }

    if (provenances.length === 0) return;

    const msg: ChainProvenanceAnnounce = {
      type: 'chain-sync:provenance-announce',
      provenances,
    };

    this.sendFn(peerId, msg);

    console.log('[ChainMergeService] Announced provenance to peer', {
      roomId: this.roomId,
      peerId,
      provenances: provenances.map((p) => p.sourceRoomId),
    });
  }

  /**
   * 處理 P2P 訊息分流
   */
  async handleMessage(fromPeerId: string, message: ChainMergeMessage): Promise<void> {
    switch (message.type) {
      case 'chain-sync:provenance-announce':
        await this.handleProvenanceAnnounce(fromPeerId, message);
        break;
      case 'chain-sync:provenance-request':
        await this.handleProvenanceRequest(fromPeerId, message);
        break;
      case 'chain-sync:provenance-response':
        await this.handleProvenanceResponse(fromPeerId, message);
        break;
    }
  }

  // ── 私有：處理 provenance-announce ─────────────────────────────────────

  private async handleProvenanceAnnounce(
    fromPeerId: string,
    msg: ChainProvenanceAnnounce
  ): Promise<void> {
    const provenanceMap = await this.db.getProvenanceEntries(this.roomId);

    for (const summary of msg.provenances) {
      const existing = provenanceMap.get(summary.sourceRoomId);

      // 若我們沒有此 provenance，或條目數比對方少，請求完整鏈
      if (!existing || existing.entries.length < summary.entryCount) {
        const request: ChainProvenanceRequest = {
          type: 'chain-sync:provenance-request',
          sourceRoomId: summary.sourceRoomId,
        };
        this.sendFn(fromPeerId, request);

        console.log('[ChainMergeService] Requesting provenance', {
          roomId: this.roomId,
          fromPeerId,
          sourceRoomId: summary.sourceRoomId,
          peerCount: summary.entryCount,
          localCount: existing?.entries.length ?? 0,
        });
      }
    }
  }

  // ── 私有：處理 provenance-request ──────────────────────────────────────

  private async handleProvenanceRequest(
    fromPeerId: string,
    msg: ChainProvenanceRequest
  ): Promise<void> {
    const provenanceMap = await this.db.getProvenanceEntries(this.roomId);
    const provenance = provenanceMap.get(msg.sourceRoomId);

    if (!provenance || provenance.entries.length === 0) {
      // 我也沒有，無法回應
      console.log('[ChainMergeService] Provenance request: not found locally', {
        roomId: this.roomId,
        fromPeerId,
        sourceRoomId: msg.sourceRoomId,
      });
      return;
    }

    const response: ChainProvenanceResponse = {
      type: 'chain-sync:provenance-response',
      sourceRoomId: msg.sourceRoomId,
      operation: provenance.operation,
      entries: provenance.entries,
    };

    this.sendFn(fromPeerId, response);

    console.log('[ChainMergeService] Sent provenance to peer', {
      roomId: this.roomId,
      fromPeerId,
      sourceRoomId: msg.sourceRoomId,
      count: provenance.entries.length,
    });
  }

  // ── 私有：處理 provenance-response ─────────────────────────────────────

  private async handleProvenanceResponse(
    fromPeerId: string,
    msg: ChainProvenanceResponse
  ): Promise<void> {
    if (!msg.entries || msg.entries.length === 0) return;

    const ok = await this.adoptProvenanceChain(
      msg.sourceRoomId,
      msg.entries,
      msg.operation
    );

    if (!ok) {
      console.warn('[ChainMergeService] Failed to adopt provenance from response', {
        roomId: this.roomId,
        fromPeerId,
        sourceRoomId: msg.sourceRoomId,
      });
    }
  }

  // ══════════════════════════════════════════════════════════════════════════
  // 歷史視圖
  // ══════════════════════════════════════════════════════════════════════════

  /**
   * 取得本房間的完整歷史（主鏈 + 所有 provenance），依 timestamp 排序
   *
   * 用於 UI 顯示，呈現合併/分岔後的完整時間線。
   * Marker 條目（_type = 'room:merged' / 'room:split_from' / 'room:split_to'）
   * 也會出現在結果中，供 UI 顯示「合併事件」通知。
   */
  async getFullHistory(): Promise<LedgerEntryWithProvenance[]> {
    return this.db.getFullHistory(this.roomId);
  }

  /**
   * 取得本房間擁有的所有 provenance 摘要（用於 P2P announce）
   */
  async getProvenanceSummaries(): Promise<ChainProvenanceSummary[]> {
    const provenanceMap = await this.db.getProvenanceEntries(this.roomId);
    const result: ChainProvenanceSummary[] = [];

    for (const [sourceRoomId, { operation, entries }] of provenanceMap) {
      if (entries.length === 0) continue;
      result.push({
        sourceRoomId,
        operation,
        entryCount: entries.length,
        lastHash: entries[entries.length - 1]!.entryHash,
      });
    }

    return result;
  }

  /**
   * 從本地 IndexedDB 取得指定 sourceRoom 的鏈條目（用於 split 時讀取 A 的鏈）
   */
  async getLocalChainAsProvenance(sourceRoomId: string): Promise<LedgerEntry[]> {
    // 從 sourceRoomId 房間自身的條目（isProvenance=0）取得
    return this.db.getChainEntries(sourceRoomId);
  }
}
