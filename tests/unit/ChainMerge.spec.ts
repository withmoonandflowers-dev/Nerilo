/**
 * ChainMergeService 完整測試
 *
 * 測試範圍：
 * ─────────────────────────────────────────────────────────────────────────────
 * A. Merge 標記（writeMergeMarker）
 *   A1. 寫入 merge marker 後主鏈長度正確
 *   A2. Marker payload 欄位正確（_type, sourceRoomId, sourceOwnerUid, mergedAt）
 *   A3. Marker 是正確的 hash 鏈條目（hash 驗證）
 *   A4. 空鏈 merge：Room A 或 Room B 為空，merge marker 仍可寫入
 *   A5. 帶入 sourceEntries 時，provenance 被立即儲存
 *
 * B. Split 標記（writeSplitFromMarker / writeSplitToMarker）
 *   B1. SplitFrom marker 寫入後，Room B 主鏈第一筆 payload 正確
 *   B2. SplitFrom marker 帶入 sourceEntries，provenance 被儲存
 *   B3. SplitTo marker 寫入後，Room A 主鏈新增正確條目
 *   B4. SplitTo marker payload 含 targetParticipants
 *
 * C. Provenance 採納（adoptProvenanceChain）
 *   C1. 合法鏈採納成功
 *   C2. 空鏈採納回傳 false
 *   C3. index 不連續採納回傳 false
 *   C4. 重複採納不會寫入重複條目（去重）
 *
 * D. P2P 訊息流（announce / request / response）
 *   D1. announceProvenanceToPeer：無 provenance 時不發送
 *   D2. announceProvenanceToPeer：有 provenance 時發送正確摘要
 *   D3. handleMessage(announce)：本地有 provenance 時不重複請求
 *   D4. handleMessage(announce)：本地無 provenance 時發出 request
 *   D5. handleMessage(request)：本地有 provenance 時發送 response
 *   D6. handleMessage(request)：本地無 provenance 時不回應
 *   D7. handleMessage(response)：儲存收到的 provenance
 *
 * E. 完整歷史視圖（getFullHistory）
 *   E1. 主鏈 + provenance 依 timestamp 排序
 *   E2. Merge marker 出現在正確位置
 *   E3. isProvenance 旗標正確
 *
 * F. 邊界情境
 *   F1. 連鎖合併：Room A 本身有 provenance，merge 進 B 後 B 也有 A 的 provenance
 *   F2. 並發 append：merge marker 寫入後，主鏈可繼續 append
 *   F3. 多次 split：Room A 分出 B 後再分出 C，A 有兩個 SplitTo markers
 *   F4. 空 Room（0 條目）split，Room B 的 provenance 也是空的
 *
 * G. ChainSyncService 整合
 *   G1. onPeerConnected：請求主鏈 + 宣告 provenance（若有 mergeService）
 *   G2. handleMessage provenance-announce → 轉交 ChainMergeService
 *   G3. 無 mergeService 時 provenance 訊息不崩潰
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SharedDataStream } from '../../src/core/mesh/SharedDataStream';
import { ChainMergeService } from '../../src/core/chain/ChainMergeService';
import { ChainSyncService } from '../../src/core/chain/ChainSyncService';
import type {
  LedgerEntry,
  ChainProvenanceAnnounce,
  ChainProvenanceRequest,
  ChainProvenanceResponse,
  ChainMergeMarkerPayload,
  ChainSplitFromMarkerPayload,
  ChainSplitToMarkerPayload,
} from '../../src/types';

// ── Mock IndexedDBService ─────────────────────────────────────────────────────

/**
 * 簡單的記憶體版 IndexedDBService mock
 * 支援所有 chain 相關方法
 */
function createMockDB() {
  // roomId → own entries（isProvenance=0）
  const ownEntries = new Map<string, LedgerEntry[]>();
  // `${roomId}:${sourceRoomId}` → { operation, entries }
  const provenanceEntries = new Map<string, { operation: 'merge' | 'split'; entries: LedgerEntry[] }>();

  return {
    // ── 主鏈 ──
    async saveChainEntry(entry: LedgerEntry, roomId: string): Promise<void> {
      const list = ownEntries.get(roomId) ?? [];
      const exists = list.some((e) => e.entryHash === entry.entryHash);
      if (!exists) {
        list.push(entry);
        ownEntries.set(roomId, list);
      }
    },
    async getChainEntries(roomId: string): Promise<LedgerEntry[]> {
      return [...(ownEntries.get(roomId) ?? [])].sort((a, b) => a.index - b.index);
    },
    async getLastChainEntry(roomId: string): Promise<LedgerEntry | null> {
      const list = ownEntries.get(roomId) ?? [];
      return list[list.length - 1] ?? null;
    },
    async clearChainEntries(roomId: string): Promise<void> {
      ownEntries.delete(roomId);
    },

    // ── Provenance ──
    async saveProvenanceEntries(
      entries: LedgerEntry[],
      targetRoomId: string,
      sourceRoomId: string,
      operation: 'merge' | 'split'
    ): Promise<void> {
      const key = `${targetRoomId}:${sourceRoomId}`;
      const existing = provenanceEntries.get(key) ?? { operation, entries: [] };
      const existingHashes = new Set(existing.entries.map((e) => e.entryHash));
      for (const entry of entries) {
        if (!existingHashes.has(entry.entryHash)) {
          existing.entries.push(entry);
        }
      }
      provenanceEntries.set(key, existing);
    },
    async getProvenanceEntries(
      roomId: string
    ): Promise<Map<string, { operation: 'merge' | 'split'; entries: LedgerEntry[] }>> {
      const result = new Map<string, { operation: 'merge' | 'split'; entries: LedgerEntry[] }>();
      for (const [key, value] of provenanceEntries) {
        if (key.startsWith(`${roomId}:`)) {
          const sourceRoomId = key.slice(roomId.length + 1);
          result.set(sourceRoomId, {
            operation: value.operation,
            entries: [...value.entries].sort((a, b) => a.index - b.index),
          });
        }
      }
      return result;
    },
    async clearProvenanceEntries(roomId: string, sourceRoomId?: string): Promise<void> {
      if (sourceRoomId) {
        provenanceEntries.delete(`${roomId}:${sourceRoomId}`);
      } else {
        for (const key of [...provenanceEntries.keys()]) {
          if (key.startsWith(`${roomId}:`)) {
            provenanceEntries.delete(key);
          }
        }
      }
    },
    async getFullHistory(roomId: string) {
      const own = (ownEntries.get(roomId) ?? []).map((e) => ({
        ...e,
        isProvenance: false,
        sourceRoomId: undefined,
        provenanceOperation: undefined,
      }));
      const provenance: ReturnType<typeof own>[number][] = [];
      for (const [key, { operation, entries }] of provenanceEntries) {
        if (key.startsWith(`${roomId}:`)) {
          const srcId = key.slice(roomId.length + 1);
          for (const e of entries) {
            provenance.push({
              ...e,
              isProvenance: true,
              sourceRoomId: srcId,
              provenanceOperation: operation,
            });
          }
        }
      }
      return [...own, ...provenance].sort((a, b) => a.timestamp - b.timestamp);
    },
    // 其他方法（不使用）
    async saveChatMessage() {},
    async getChatMessages() { return []; },
    async clearRoomData() {},
    async clearAllData() {},

    // 測試輔助：直接讀取內部狀態
    _ownEntries: ownEntries,
    _provenanceEntries: provenanceEntries,
  };
}

// ── 工廠函式 ──────────────────────────────────────────────────────────────────

function createStream(roomId: string, creatorId = 'user-a') {
  return new SharedDataStream({ roomId, creatorId, appendRateLimitPerSecond: 1000 });
}

function createMergeService(
  roomId: string,
  stream: SharedDataStream,
  db: ReturnType<typeof createMockDB>,
  sentMessages: Array<{ peerId: string; message: unknown }>
) {
  return new ChainMergeService({
    roomId,
    stream,
    db: db as any,
    sendFn: (peerId, message) => sentMessages.push({ peerId, message }),
  });
}

/** 建立 N 筆合法 LedgerEntry 組成的鏈 */
async function buildChain(
  stream: SharedDataStream,
  count: number,
  payloadPrefix = 'msg'
): Promise<LedgerEntry[]> {
  const entries: LedgerEntry[] = [];
  for (let i = 0; i < count; i++) {
    const e = await stream.append({ content: `${payloadPrefix}-${i}`, index: i });
    entries.push(e);
  }
  return entries;
}

// ═══════════════════════════════════════════════════════════════════════════════
// A. Merge 標記
// ═══════════════════════════════════════════════════════════════════════════════

describe('A. Merge 標記（writeMergeMarker）', () => {
  it('A1. 寫入 merge marker 後主鏈長度正確', async () => {
    const db = createMockDB();
    const streamB = createStream('room-B', 'owner-B');
    await buildChain(streamB, 3, 'B');
    const sent: any[] = [];
    const mergeService = createMergeService('room-B', streamB, db, sent);

    await mergeService.writeMergeMarker('room-A', 'owner-A');

    // 原本 3 筆 + 1 筆 marker = 4 筆
    expect(streamB.getEntries().length).toBe(4);
  });

  it('A2. Marker payload 欄位正確', async () => {
    const db = createMockDB();
    const streamB = createStream('room-B', 'owner-B');
    const sent: any[] = [];
    const mergeService = createMergeService('room-B', streamB, db, sent);

    const before = Date.now();
    const marker = await mergeService.writeMergeMarker('room-A', 'owner-A');
    const after = Date.now();

    const payload = marker.payload as ChainMergeMarkerPayload;
    expect(payload._type).toBe('room:merged');
    expect(payload.sourceRoomId).toBe('room-A');
    expect(payload.sourceOwnerUid).toBe('owner-A');
    expect(payload.mergedAt).toBeGreaterThanOrEqual(before);
    expect(payload.mergedAt).toBeLessThanOrEqual(after);
  });

  it('A3. Marker 是正確的 hash 鏈條目', async () => {
    const db = createMockDB();
    const streamB = createStream('room-B', 'owner-B');
    await buildChain(streamB, 2, 'B');
    const sent: any[] = [];
    const mergeService = createMergeService('room-B', streamB, db, sent);

    const marker = await mergeService.writeMergeMarker('room-A', 'owner-A');

    // marker 的 previousHash 必須是前一筆的 entryHash
    const entries = streamB.getEntries();
    expect(marker.index).toBe(2);
    expect(marker.previousHash).toBe(entries[1]!.entryHash);
    expect(marker.entryHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('A4. 空鏈 merge：Room B 為空時 marker 可正常寫入', async () => {
    const db = createMockDB();
    const streamB = createStream('room-B', 'owner-B');
    const sent: any[] = [];
    const mergeService = createMergeService('room-B', streamB, db, sent);

    const marker = await mergeService.writeMergeMarker('room-A', 'owner-A');

    expect(marker.index).toBe(0);
    expect(marker.previousHash).toBe('0'); // genesis
    expect(streamB.getEntries().length).toBe(1);
  });

  it('A5. 帶入 sourceEntries 時，provenance 被立即儲存', async () => {
    const db = createMockDB();
    const streamA = createStream('room-A', 'owner-A');
    const sourceEntries = await buildChain(streamA, 4, 'A');
    const streamB = createStream('room-B', 'owner-B');
    const sent: any[] = [];
    const mergeService = createMergeService('room-B', streamB, db, sent);

    await mergeService.writeMergeMarker('room-A', 'owner-A', sourceEntries);

    const provenance = await db.getProvenanceEntries('room-B');
    expect(provenance.has('room-A')).toBe(true);
    expect(provenance.get('room-A')!.entries.length).toBe(4);
    expect(provenance.get('room-A')!.operation).toBe('merge');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// B. Split 標記
// ═══════════════════════════════════════════════════════════════════════════════

describe('B. Split 標記（writeSplitFromMarker / writeSplitToMarker）', () => {
  it('B1. SplitFrom marker 寫入後，Room B 主鏈第一筆 payload 正確', async () => {
    const db = createMockDB();
    const streamA = createStream('room-A', 'owner-A');
    const sourceEntries = await buildChain(streamA, 5, 'A');
    const streamB = createStream('room-B', 'new-owner');
    const sent: any[] = [];
    const mergeServiceB = createMergeService('room-B', streamB, db, sent);

    const before = Date.now();
    const marker = await mergeServiceB.writeSplitFromMarker('room-A', sourceEntries);
    const after = Date.now();

    expect(streamB.getEntries().length).toBe(1);
    const payload = marker.payload as ChainSplitFromMarkerPayload;
    expect(payload._type).toBe('room:split_from');
    expect(payload.sourceRoomId).toBe('room-A');
    expect(payload.sourceChainLength).toBe(5);
    expect(payload.splitAt).toBeGreaterThanOrEqual(before);
    expect(payload.splitAt).toBeLessThanOrEqual(after);
  });

  it('B2. SplitFrom marker 帶入 sourceEntries，provenance 被儲存', async () => {
    const db = createMockDB();
    const streamA = createStream('room-A', 'owner-A');
    const sourceEntries = await buildChain(streamA, 3, 'A');
    const streamB = createStream('room-B', 'new-owner');
    const sent: any[] = [];
    const mergeServiceB = createMergeService('room-B', streamB, db, sent);

    await mergeServiceB.writeSplitFromMarker('room-A', sourceEntries);

    const provenance = await db.getProvenanceEntries('room-B');
    expect(provenance.has('room-A')).toBe(true);
    expect(provenance.get('room-A')!.entries.length).toBe(3);
    expect(provenance.get('room-A')!.operation).toBe('split');
  });

  it('B3. SplitTo marker 寫入後，Room A 主鏈新增正確條目', async () => {
    const db = createMockDB();
    const streamA = createStream('room-A', 'owner-A');
    await buildChain(streamA, 3, 'A');
    const sent: any[] = [];
    const mergeServiceA = createMergeService('room-A', streamA, db, sent);

    await mergeServiceA.writeSplitToMarker('room-B', ['user-2', 'user-3']);

    expect(streamA.getEntries().length).toBe(4); // 3 + 1 marker
    const marker = streamA.getLastEntry()!;
    const payload = marker.payload as ChainSplitToMarkerPayload;
    expect(payload._type).toBe('room:split_to');
    expect(payload.targetRoomId).toBe('room-B');
  });

  it('B4. SplitTo marker payload 含 targetParticipants', async () => {
    const db = createMockDB();
    const streamA = createStream('room-A', 'owner-A');
    const sent: any[] = [];
    const mergeServiceA = createMergeService('room-A', streamA, db, sent);

    await mergeServiceA.writeSplitToMarker('room-B', ['user-2', 'user-3']);

    const payload = streamA.getLastEntry()!.payload as ChainSplitToMarkerPayload;
    expect(payload.targetParticipants).toEqual(['user-2', 'user-3']);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// C. Provenance 採納
// ═══════════════════════════════════════════════════════════════════════════════

describe('C. Provenance 採納（adoptProvenanceChain）', () => {
  it('C1. 合法鏈採納成功，回傳 true', async () => {
    const db = createMockDB();
    const streamA = createStream('room-A', 'owner-A');
    const entries = await buildChain(streamA, 4, 'A');
    const streamB = createStream('room-B', 'owner-B');
    const sent: any[] = [];
    const mergeService = createMergeService('room-B', streamB, db, sent);

    const ok = await mergeService.adoptProvenanceChain('room-A', entries, 'merge');

    expect(ok).toBe(true);
    const provenance = await db.getProvenanceEntries('room-B');
    expect(provenance.get('room-A')!.entries.length).toBe(4);
  });

  it('C2. 空鏈採納回傳 false', async () => {
    const db = createMockDB();
    const streamB = createStream('room-B', 'owner-B');
    const sent: any[] = [];
    const mergeService = createMergeService('room-B', streamB, db, sent);

    const ok = await mergeService.adoptProvenanceChain('room-A', [], 'merge');

    expect(ok).toBe(false);
  });

  it('C3. index 不連續採納回傳 false', async () => {
    const db = createMockDB();
    const streamA = createStream('room-A', 'owner-A');
    const entries = await buildChain(streamA, 3, 'A');
    // 製造 index 跳號
    const badEntries = [entries[0]!, entries[2]!]; // index: 0, 2（跳過 1）
    const streamB = createStream('room-B', 'owner-B');
    const sent: any[] = [];
    const mergeService = createMergeService('room-B', streamB, db, sent);

    const ok = await mergeService.adoptProvenanceChain('room-A', badEntries, 'merge');

    expect(ok).toBe(false);
  });

  it('C4. 重複採納不會寫入重複條目', async () => {
    const db = createMockDB();
    const streamA = createStream('room-A', 'owner-A');
    const entries = await buildChain(streamA, 3, 'A');
    const streamB = createStream('room-B', 'owner-B');
    const sent: any[] = [];
    const mergeService = createMergeService('room-B', streamB, db, sent);

    await mergeService.adoptProvenanceChain('room-A', entries, 'merge');
    await mergeService.adoptProvenanceChain('room-A', entries, 'merge'); // 重複

    const provenance = await db.getProvenanceEntries('room-B');
    // 去重後仍只有 3 筆
    expect(provenance.get('room-A')!.entries.length).toBe(3);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// D. P2P 訊息流
// ═══════════════════════════════════════════════════════════════════════════════

describe('D. P2P 訊息流（announce / request / response）', () => {
  it('D1. announceProvenanceToPeer：無 provenance 時不發送訊息', async () => {
    const db = createMockDB();
    const streamB = createStream('room-B', 'owner-B');
    const sent: any[] = [];
    const mergeService = createMergeService('room-B', streamB, db, sent);

    await mergeService.announceProvenanceToPeer('peer-X');

    expect(sent.length).toBe(0);
  });

  it('D2. announceProvenanceToPeer：有 provenance 時發送正確摘要', async () => {
    const db = createMockDB();
    const streamA = createStream('room-A', 'owner-A');
    const entriesA = await buildChain(streamA, 4, 'A');
    const streamB = createStream('room-B', 'owner-B');
    const sent: any[] = [];
    const mergeService = createMergeService('room-B', streamB, db, sent);
    await mergeService.adoptProvenanceChain('room-A', entriesA, 'merge');

    await mergeService.announceProvenanceToPeer('peer-X');

    expect(sent.length).toBe(1);
    const msg = sent[0]!.message as ChainProvenanceAnnounce;
    expect(msg.type).toBe('chain-sync:provenance-announce');
    expect(msg.provenances.length).toBe(1);
    expect(msg.provenances[0]!.sourceRoomId).toBe('room-A');
    expect(msg.provenances[0]!.entryCount).toBe(4);
    expect(msg.provenances[0]!.operation).toBe('merge');
    expect(msg.provenances[0]!.lastHash).toBe(entriesA[3]!.entryHash);
    expect(sent[0]!.peerId).toBe('peer-X');
  });

  it('D3. handleMessage(announce)：本地已有 provenance 時，不發出 request', async () => {
    const db = createMockDB();
    const streamA = createStream('room-A', 'owner-A');
    const entriesA = await buildChain(streamA, 3, 'A');
    const streamB = createStream('room-B', 'owner-B');
    const sent: any[] = [];
    const mergeService = createMergeService('room-B', streamB, db, sent);
    // 本地已有 room-A 的 provenance（3 筆）
    await mergeService.adoptProvenanceChain('room-A', entriesA, 'merge');

    // 對方宣告也有 3 筆（數量相同）
    const announce: ChainProvenanceAnnounce = {
      type: 'chain-sync:provenance-announce',
      provenances: [
        { sourceRoomId: 'room-A', operation: 'merge', entryCount: 3, lastHash: entriesA[2]!.entryHash },
      ],
    };
    await mergeService.handleMessage('peer-X', announce);

    // 不應發出 provenance-request
    const requests = sent.filter((s) => s.message.type === 'chain-sync:provenance-request');
    expect(requests.length).toBe(0);
  });

  it('D4. handleMessage(announce)：本地無 provenance 時，發出 request', async () => {
    const db = createMockDB();
    const streamB = createStream('room-B', 'owner-B');
    const sent: any[] = [];
    const mergeService = createMergeService('room-B', streamB, db, sent);

    const announce: ChainProvenanceAnnounce = {
      type: 'chain-sync:provenance-announce',
      provenances: [
        { sourceRoomId: 'room-A', operation: 'merge', entryCount: 3, lastHash: 'abc' },
      ],
    };
    await mergeService.handleMessage('peer-X', announce);

    expect(sent.length).toBe(1);
    const req = sent[0]!.message as ChainProvenanceRequest;
    expect(req.type).toBe('chain-sync:provenance-request');
    expect(req.sourceRoomId).toBe('room-A');
    expect(sent[0]!.peerId).toBe('peer-X');
  });

  it('D5. handleMessage(request)：本地有 provenance 時，發送 response', async () => {
    const db = createMockDB();
    const streamA = createStream('room-A', 'owner-A');
    const entriesA = await buildChain(streamA, 3, 'A');
    const streamB = createStream('room-B', 'owner-B');
    const sent: any[] = [];
    const mergeService = createMergeService('room-B', streamB, db, sent);
    await mergeService.adoptProvenanceChain('room-A', entriesA, 'merge');

    const request: ChainProvenanceRequest = {
      type: 'chain-sync:provenance-request',
      sourceRoomId: 'room-A',
    };
    await mergeService.handleMessage('peer-Y', request);

    expect(sent.length).toBe(1);
    const resp = sent[0]!.message as ChainProvenanceResponse;
    expect(resp.type).toBe('chain-sync:provenance-response');
    expect(resp.sourceRoomId).toBe('room-A');
    expect(resp.operation).toBe('merge');
    expect(resp.entries.length).toBe(3);
    expect(sent[0]!.peerId).toBe('peer-Y');
  });

  it('D6. handleMessage(request)：本地無 provenance 時，不發送任何訊息', async () => {
    const db = createMockDB();
    const streamB = createStream('room-B', 'owner-B');
    const sent: any[] = [];
    const mergeService = createMergeService('room-B', streamB, db, sent);

    const request: ChainProvenanceRequest = {
      type: 'chain-sync:provenance-request',
      sourceRoomId: 'room-A', // 我沒有
    };
    await mergeService.handleMessage('peer-Y', request);

    expect(sent.length).toBe(0);
  });

  it('D7. handleMessage(response)：儲存收到的 provenance', async () => {
    const db = createMockDB();
    const streamA = createStream('room-A', 'owner-A');
    const entriesA = await buildChain(streamA, 4, 'A');
    const streamB = createStream('room-B', 'owner-B');
    const sent: any[] = [];
    const mergeService = createMergeService('room-B', streamB, db, sent);

    const response: ChainProvenanceResponse = {
      type: 'chain-sync:provenance-response',
      sourceRoomId: 'room-A',
      operation: 'merge',
      entries: entriesA,
    };
    await mergeService.handleMessage('peer-X', response);

    const provenance = await db.getProvenanceEntries('room-B');
    expect(provenance.has('room-A')).toBe(true);
    expect(provenance.get('room-A')!.entries.length).toBe(4);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// E. 完整歷史視圖
// ═══════════════════════════════════════════════════════════════════════════════

describe('E. 完整歷史視圖（getFullHistory）', () => {
  it('E1. 主鏈 + provenance 依 timestamp 排序', async () => {
    const db = createMockDB();

    // Room A 條目（早期時間）
    const streamA = createStream('room-A', 'owner-A');
    const aEntries: LedgerEntry[] = [];
    aEntries.push(await streamA.append({ content: 'A-msg-0' }));
    await new Promise((r) => setTimeout(r, 5));
    aEntries.push(await streamA.append({ content: 'A-msg-1' }));

    // Room B 條目（晚期時間，和 A 交錯）
    const streamB = createStream('room-B', 'owner-B');
    await new Promise((r) => setTimeout(r, 5));
    await streamB.append({ content: 'B-msg-0' });
    await new Promise((r) => setTimeout(r, 5));
    await streamB.append({ content: 'B-msg-1' });

    // 儲存到 mock db
    for (const e of streamB.getEntries()) {
      await db.saveChainEntry(e, 'room-B');
    }
    const sent: any[] = [];
    const mergeService = createMergeService('room-B', streamB, db, sent);

    // 寫入 merge marker
    await mergeService.writeMergeMarker('room-A', 'owner-A', aEntries);

    // 取得完整歷史
    const history = await mergeService.getFullHistory();

    // 所有條目依 timestamp 排序
    for (let i = 1; i < history.length; i++) {
      expect(history[i]!.timestamp).toBeGreaterThanOrEqual(history[i - 1]!.timestamp);
    }

    // 總條目數：A(2) + B(2 + 1 marker) = 5
    expect(history.length).toBe(5);
  });

  it('E2. Merge marker 出現在結果中，payload._type 正確', async () => {
    const db = createMockDB();
    const streamA = createStream('room-A', 'owner-A');
    const entriesA = await buildChain(streamA, 2, 'A');
    const streamB = createStream('room-B', 'owner-B');
    const sent: any[] = [];
    const mergeService = createMergeService('room-B', streamB, db, sent);
    for (const e of streamB.getEntries()) await db.saveChainEntry(e, 'room-B');

    await mergeService.writeMergeMarker('room-A', 'owner-A', entriesA);
    // 儲存 marker 到 db
    await db.saveChainEntry(streamB.getLastEntry()!, 'room-B');

    const history = await mergeService.getFullHistory();
    const marker = history.find((e) => (e.payload as any)._type === 'room:merged');
    expect(marker).toBeDefined();
    expect((marker!.payload as ChainMergeMarkerPayload).sourceRoomId).toBe('room-A');
  });

  it('E3. isProvenance 旗標正確', async () => {
    const db = createMockDB();
    const streamA = createStream('room-A', 'owner-A');
    const entriesA = await buildChain(streamA, 2, 'A');
    const streamB = createStream('room-B', 'owner-B');
    await streamB.append({ content: 'B-own' });
    for (const e of streamB.getEntries()) await db.saveChainEntry(e, 'room-B');

    const sent: any[] = [];
    const mergeService = createMergeService('room-B', streamB, db, sent);
    await mergeService.adoptProvenanceChain('room-A', entriesA, 'merge');

    const history = await mergeService.getFullHistory();

    const ownEntries = history.filter((e) => !e.isProvenance);
    const provenanceEntries = history.filter((e) => e.isProvenance);

    expect(ownEntries.length).toBe(1);          // B 自身 1 筆
    expect(provenanceEntries.length).toBe(2);   // A 的 2 筆 provenance
    for (const e of provenanceEntries) {
      expect(e.sourceRoomId).toBe('room-A');
      expect(e.provenanceOperation).toBe('merge');
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// F. 邊界情境
// ═══════════════════════════════════════════════════════════════════════════════

describe('F. 邊界情境', () => {
  it('F1. 連鎖合併：Room A 有 provenance（來自 Room Z），merge 進 B 後 B 也取得相同 provenance', async () => {
    // Room Z → Room A（merge）→ Room B（merge）
    const db = createMockDB();
    const streamZ = createStream('room-Z', 'owner-Z');
    const entriesZ = await buildChain(streamZ, 2, 'Z');
    const streamA = createStream('room-A', 'owner-A');
    await buildChain(streamA, 2, 'A');
    const sent: any[] = [];
    const mergeServiceA = createMergeService('room-A', streamA, db, sent);
    // A 採納 Z 的 provenance
    await mergeServiceA.adoptProvenanceChain('room-Z', entriesZ, 'merge');
    await mergeServiceA.writeMergeMarker('room-Z', 'owner-Z');

    // 現在 A merge 進 B
    const streamB = createStream('room-B', 'owner-B');
    const sentB: any[] = [];
    const mergeServiceB = createMergeService('room-B', streamB, db, sentB);

    // B 採納 A 的 provenance（A 現在包含 Z 的 provenance 和 A 本身的條目）
    const aEntries = streamA.getEntries() as LedgerEntry[];
    await mergeServiceB.adoptProvenanceChain('room-A', aEntries, 'merge');

    // B 宣告時，應包含來自 room-A 的 provenance
    await mergeServiceB.announceProvenanceToPeer('some-peer');
    const announceMsg = sentB[0]?.message as ChainProvenanceAnnounce;
    expect(announceMsg.type).toBe('chain-sync:provenance-announce');
    const sourceIds = announceMsg.provenances.map((p) => p.sourceRoomId);
    expect(sourceIds).toContain('room-A');
  });

  it('F2. 並發 append：merge marker 寫入後，主鏈可繼續正常 append', async () => {
    const db = createMockDB();
    const streamB = createStream('room-B', 'owner-B');
    await buildChain(streamB, 2, 'B');
    const sent: any[] = [];
    const mergeService = createMergeService('room-B', streamB, db, sent);

    const marker = await mergeService.writeMergeMarker('room-A', 'owner-A');

    // marker 之後繼續 append
    const next = await streamB.append({ content: 'after-merge' });
    expect(next.index).toBe(marker.index + 1);
    expect(next.previousHash).toBe(marker.entryHash);
    expect(streamB.getEntries().length).toBe(4);
  });

  it('F3. 多次 split：Room A 先分出 B 再分出 C，A 有兩個 SplitTo markers', async () => {
    const db = createMockDB();
    const streamA = createStream('room-A', 'owner-A');
    await buildChain(streamA, 3, 'A');
    const sent: any[] = [];
    const mergeServiceA = createMergeService('room-A', streamA, db, sent);

    await mergeServiceA.writeSplitToMarker('room-B', ['user-2']);
    await mergeServiceA.writeSplitToMarker('room-C', ['user-3']);

    const entries = streamA.getEntries();
    expect(entries.length).toBe(5); // 3 + 2 markers
    const splitToMarkers = entries.filter(
      (e) => (e.payload as any)._type === 'room:split_to'
    );
    expect(splitToMarkers.length).toBe(2);
    expect((splitToMarkers[0]!.payload as ChainSplitToMarkerPayload).targetRoomId).toBe('room-B');
    expect((splitToMarkers[1]!.payload as ChainSplitToMarkerPayload).targetRoomId).toBe('room-C');
  });

  it('F4. 空 Room（0 條目）split，Room B 的 split_from marker 記錄 sourceChainLength = 0', async () => {
    const db = createMockDB();
    const streamB = createStream('room-B', 'new-owner');
    const sent: any[] = [];
    const mergeServiceB = createMergeService('room-B', streamB, db, sent);

    // Room A 是空鏈
    const marker = await mergeServiceB.writeSplitFromMarker('room-A', []);

    const payload = marker.payload as ChainSplitFromMarkerPayload;
    expect(payload.sourceChainLength).toBe(0);
    expect(payload._type).toBe('room:split_from');
    expect(streamB.getEntries().length).toBe(1);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// G. ChainSyncService 整合
// ═══════════════════════════════════════════════════════════════════════════════

describe('G. ChainSyncService 整合', () => {
  it('G1. onPeerConnected：發送 chain-sync:request，並宣告 provenance（若有 mergeService）', async () => {
    const db = createMockDB();
    const streamA = createStream('room-A', 'owner-A');
    const entriesA = await buildChain(streamA, 3, 'A');
    const streamB = createStream('room-B', 'owner-B');
    const sentMsgs: Array<{ peerId: string; message: unknown }> = [];
    const sendFn = (peerId: string, message: unknown) => sentMsgs.push({ peerId, message });

    const syncService = new ChainSyncService({ roomId: 'room-B', stream: streamB, sendFn });
    const mergeService = new ChainMergeService({
      roomId: 'room-B', stream: streamB, db: db as any, sendFn,
    });
    syncService.setMergeService(mergeService);

    // B 有 room-A 的 provenance
    await mergeService.adoptProvenanceChain('room-A', entriesA, 'merge');

    await syncService.onPeerConnected('peer-new');

    // 應有 chain-sync:request
    const syncReq = sentMsgs.find((s) => (s.message as any).type === 'chain-sync:request');
    expect(syncReq).toBeDefined();
    expect(syncReq!.peerId).toBe('peer-new');

    // 應有 chain-sync:provenance-announce
    const announce = sentMsgs.find((s) => (s.message as any).type === 'chain-sync:provenance-announce');
    expect(announce).toBeDefined();
    expect(announce!.peerId).toBe('peer-new');
  });

  it('G2. handleMessage provenance-announce → 轉交 ChainMergeService 處理（發出 request）', async () => {
    const db = createMockDB();
    const streamB = createStream('room-B', 'owner-B');
    const sentMsgs: Array<{ peerId: string; message: unknown }> = [];
    const sendFn = (peerId: string, message: unknown) => sentMsgs.push({ peerId, message });

    const syncService = new ChainSyncService({ roomId: 'room-B', stream: streamB, sendFn });
    const mergeService = new ChainMergeService({
      roomId: 'room-B', stream: streamB, db: db as any, sendFn,
    });
    syncService.setMergeService(mergeService);

    const announce: ChainProvenanceAnnounce = {
      type: 'chain-sync:provenance-announce',
      provenances: [
        { sourceRoomId: 'room-A', operation: 'merge', entryCount: 3, lastHash: 'abc' },
      ],
    };
    await syncService.handleMessage('peer-X', announce);

    // ChainMergeService 應發出 provenance-request
    const req = sentMsgs.find((s) => (s.message as any).type === 'chain-sync:provenance-request');
    expect(req).toBeDefined();
    expect((req!.message as ChainProvenanceRequest).sourceRoomId).toBe('room-A');
  });

  it('G3. 無 mergeService 時收到 provenance 訊息不崩潰', async () => {
    const streamB = createStream('room-B', 'owner-B');
    const sent: any[] = [];
    const sendFn = (peerId: string, message: unknown) => sent.push({ peerId, message });
    const syncService = new ChainSyncService({ roomId: 'room-B', stream: streamB, sendFn });
    // 不呼叫 setMergeService

    const announce: ChainProvenanceAnnounce = {
      type: 'chain-sync:provenance-announce',
      provenances: [
        { sourceRoomId: 'room-A', operation: 'merge', entryCount: 2, lastHash: 'xyz' },
      ],
    };
    // 不應拋錯
    await expect(syncService.handleMessage('peer-X', announce)).resolves.not.toThrow();
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 完整 Merge 情境端對端模擬
// ═══════════════════════════════════════════════════════════════════════════════

describe('端對端模擬：完整 Merge 情境', () => {
  it('Room A(4 條) merge 進 Room B(3 條)，B 的完整歷史包含 7+1(marker) 條', async () => {
    // ── 建立兩個房間 ──
    const dbA = createMockDB();
    const dbB = createMockDB();
    const streamA = createStream('room-A', 'owner-A');
    const streamB = createStream('room-B', 'owner-B');

    // Room A: 4 條
    const entriesA = await buildChain(streamA, 4, 'A');
    for (const e of entriesA) await dbA.saveChainEntry(e, 'room-A');

    // Room B: 3 條
    await buildChain(streamB, 3, 'B');
    for (const e of streamB.getEntries()) await dbB.saveChainEntry(e, 'room-B');

    // ── Room B owner 接受 merge ──
    const sentB: any[] = [];
    const mergeServiceB = createMergeService('room-B', streamB, dbB, sentB);

    // 1. 寫入 merge marker（B owner 沒有 A 的鏈，不帶 sourceEntries）
    const marker = await mergeServiceB.writeMergeMarker('room-A', 'owner-A');
    await dbB.saveChainEntry(marker, 'room-B');

    // ── Room A 成員連進 Room B，透過 P2P 宣告 provenance ──

    // A 成員宣告：我有 room-A 的 4 筆
    const sentA: any[] = [];
    const mergeServiceBFromA = createMergeService('room-B', streamB, dbB, sentA);
    // 模擬：A 成員告訴 B 成員「我有 room-A 的 provenance」
    const announce: ChainProvenanceAnnounce = {
      type: 'chain-sync:provenance-announce',
      provenances: [
        { sourceRoomId: 'room-A', operation: 'merge', entryCount: 4, lastHash: entriesA[3]!.entryHash },
      ],
    };
    await mergeServiceBFromA.handleMessage('owner-A', announce);
    // B 應發出 request（因為本地沒有 room-A 的 provenance）
    expect(sentA.some((s) => s.message.type === 'chain-sync:provenance-request')).toBe(true);

    // A 成員發送 response（帶完整 A 鏈）
    const response: ChainProvenanceResponse = {
      type: 'chain-sync:provenance-response',
      sourceRoomId: 'room-A',
      operation: 'merge',
      entries: entriesA,
    };
    await mergeServiceBFromA.handleMessage('owner-A', response);

    // ── 驗證 Room B 的完整歷史 ──
    const history = await mergeServiceBFromA.getFullHistory();

    // 3(B) + 1(marker) + 4(A provenance) = 8 條
    expect(history.length).toBe(8);

    // marker 存在
    const mergeMarker = history.find((e) => (e.payload as any)._type === 'room:merged');
    expect(mergeMarker).toBeDefined();

    // provenance 條目的 isProvenance = true
    const provenanceCount = history.filter((e) => e.isProvenance).length;
    expect(provenanceCount).toBe(4);

    // 主鏈條目的 isProvenance = false
    const ownCount = history.filter((e) => !e.isProvenance).length;
    expect(ownCount).toBe(4); // 3 + 1 marker

    // 依 timestamp 排序
    for (let i = 1; i < history.length; i++) {
      expect(history[i]!.timestamp).toBeGreaterThanOrEqual(history[i - 1]!.timestamp);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 完整 Split 情境端對端模擬
// ═══════════════════════════════════════════════════════════════════════════════

describe('端對端模擬：完整 Split 情境', () => {
  it('Room A(5 條) split，B 的 provenance 包含 A 的所有 5 條', async () => {
    // Room A 有 5 條
    const dbA = createMockDB();
    const streamA = createStream('room-A', 'owner-A');
    const entriesA = await buildChain(streamA, 5, 'A');
    for (const e of entriesA) await dbA.saveChainEntry(e, 'room-A');

    // ── split 計劃完成，new owner（user-2）建立 Room B ──
    const dbB = createMockDB();
    const streamB = createStream('room-B', 'user-2');
    const sentB: any[] = [];
    const mergeServiceB = createMergeService('room-B', streamB, dbB, sentB);

    // new owner 讀取自己 IndexedDB 裡 room-A 的鏈（他之前在 A）
    const sourceEntriesFromA = await dbA.getChainEntries('room-A');
    const marker = await mergeServiceB.writeSplitFromMarker('room-A', sourceEntriesFromA);

    // Room B 之後繼續寫入（split 後的新訊息）
    const firstMsgB = await streamB.append({ content: 'first-msg-in-B' });
    await dbB.saveChainEntry(firstMsgB, 'room-B');

    // ── Room A owner 寫入 SplitTo marker ──
    const sentA: any[] = [];
    const mergeServiceA = createMergeService('room-A', streamA, dbA, sentA);
    await mergeServiceA.writeSplitToMarker('room-B', ['user-2', 'user-3']);

    // ── 驗證 Room B ──
    expect(streamB.getEntries().length).toBe(2); // split_from marker + 1 msg

    // split_from marker 是第一筆
    expect(marker.index).toBe(0);
    expect((marker.payload as ChainSplitFromMarkerPayload).sourceChainLength).toBe(5);

    // Room B 的 provenance 包含 A 的 5 筆
    const historyB = await mergeServiceB.getFullHistory();
    const provenanceInB = historyB.filter((e) => e.isProvenance);
    expect(provenanceInB.length).toBe(5);
    expect(provenanceInB.every((e) => e.sourceRoomId === 'room-A')).toBe(true);
    expect(provenanceInB.every((e) => e.provenanceOperation === 'split')).toBe(true);

    // ── 驗證 Room A ──
    const splitToMarkerA = streamA.getLastEntry()!;
    expect((splitToMarkerA.payload as ChainSplitToMarkerPayload)._type).toBe('room:split_to');
    expect((splitToMarkerA.payload as ChainSplitToMarkerPayload).targetRoomId).toBe('room-B');

    // Room A 總共：5 + 1(split_to) = 6 條
    expect(streamA.getEntries().length).toBe(6);

    // Room B 完整歷史：2(B own) + 5(A provenance) = 7 條
    expect(historyB.length).toBe(7);

    // 依 timestamp 排序
    for (let i = 1; i < historyB.length; i++) {
      expect(historyB[i]!.timestamp).toBeGreaterThanOrEqual(historyB[i - 1]!.timestamp);
    }
  });
});
