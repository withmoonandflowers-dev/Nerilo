/**
 * RelaySignaling — 陌生節點站級 signaling 通道（ADR-0023 P4-B）
 *
 * 現行 WebRTC signaling 綁在 `p2pRooms/{roomId}/signals`，只有同房成員能讀寫，
 * 非成員（盲信使）進不來。本模組提供「不綁房」的 pairwise signaling：兩個站上
 * 互為陌生人的節點（經 relayDirectory 發現彼此，P4-A）在一條由雙方 uid 決定的
 * 通道上交換 offer/answer/ICE，供之後建立 relay-only DataChannel（WebRTC 接線＝P4-B.2）。
 *
 * 資料模型（對齊房內 signals 的驗證形狀）：
 *   relaySignals/{channelId}                      { participants:[uidA,uidB], createdAt }
 *   relaySignals/{channelId}/signals/{signalId}   { from, type, payload, createdAt }
 * channelId = 兩 uid 排序後串接（deterministic，雙方各自算得同一條）。
 *
 * 安全（firestore.rules 落實）：只有 participants 內的兩人能讀寫該通道；signal 的
 * from 必須==auth.uid；非匿名才可開通道（反女巫，對齊 relayDirectory）。
 *
 * 沿用房內 signaling 的韌性招式：lookback 窗（涵蓋一方先到）＋ signalId 去重
 * ＋略過自己送的。純 signaling 傳輸，不含 RTCPeerConnection（那是 B.2）。
 */

import {
  collection,
  doc,
  setDoc,
  addDoc,
  onSnapshot,
  query,
  where,
  orderBy,
  limit,
  Timestamp,
} from 'firebase/firestore';
import { db } from '../../config/firebase';
import { logger } from '../../utils/logger';

/** 回看窗：涵蓋「一方先寫 offer、另一方數分鐘內才上線訂閱」 */
const LOOKBACK_MS = 5 * 60 * 1000;

export type RelaySignalType = 'offer' | 'answer' | 'ice';

export interface RelaySignal {
  signalId: string;
  from: string;
  type: RelaySignalType;
  payload: Record<string, unknown>;
  createdAt: number | { toMillis?: () => number };
}

/** 兩節點的 pairwise 通道 id：排序後串接，雙方算得一致。 */
export function relayChannelId(uidA: string, uidB: string): string {
  return [uidA, uidB].sort().join('__');
}

export class RelaySignalingChannel {
  private readonly channelId: string;
  private readonly processed = new Set<string>();
  private unsub: (() => void) | null = null;

  constructor(
    private readonly localUid: string,
    private readonly remoteUid: string
  ) {
    this.channelId = relayChannelId(localUid, remoteUid);
  }

  getChannelId(): string {
    return this.channelId;
  }

  /**
   * 確保 pairwise 通道文件存在（帶 participants，供 rules 授權子集合讀寫）。
   * 冪等：雙方各呼叫一次皆可（merge，participants 不變）。send/subscribe 前必呼叫。
   */
  async ensureChannel(): Promise<void> {
    await setDoc(
      doc(db, 'relaySignals', this.channelId),
      {
        participants: [this.localUid, this.remoteUid].sort(),
        createdAt: Timestamp.now(),
      },
      { merge: true }
    );
  }

  /** 送一則 signal（offer/answer/ice）。payload 需為可序列化 JSON（SDP/candidate 欄位）。 */
  async send(type: RelaySignalType, payload: Record<string, unknown>): Promise<void> {
    await addDoc(collection(db, 'relaySignals', this.channelId, 'signals'), {
      from: this.localUid,
      type,
      payload,
      createdAt: Timestamp.now(),
    });
  }

  /**
   * 訂閱對方送來的 signal（略過自己送的、去重、lookback 窗）。
   * 回傳取消訂閱函式。
   */
  subscribe(onSignal: (signal: RelaySignal) => void): () => void {
    const cutoff = Timestamp.fromMillis(Date.now() - LOOKBACK_MS);
    const q = query(
      collection(db, 'relaySignals', this.channelId, 'signals'),
      where('createdAt', '>=', cutoff),
      orderBy('createdAt', 'asc'),
      limit(50)
    );
    this.unsub = onSnapshot(q, (snap) => {
      for (const change of snap.docChanges()) {
        if (change.type !== 'added') continue;
        const signal = { ...change.doc.data(), signalId: change.doc.id } as RelaySignal;
        if (this.processed.has(signal.signalId)) continue;
        this.processed.add(signal.signalId);
        if (signal.from === this.localUid) continue; // 略過自己送的
        try {
          onSignal(signal);
        } catch (err) {
          logger.error('[RelaySignaling] onSignal handler error', { channelId: this.channelId, err });
        }
      }
    });
    return () => this.cleanup();
  }

  cleanup(): void {
    if (this.unsub) {
      this.unsub();
      this.unsub = null;
    }
  }
}
