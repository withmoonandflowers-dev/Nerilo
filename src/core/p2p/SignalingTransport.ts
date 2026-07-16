/**
 * SignalingTransport — WebRTC signaling 的「傳輸位置」抽象（ADR-0023 P4-B.2）
 *
 * P2PConnectionManager 的 WebRTC 邏輯（offer/answer/ICE、perfect-negotiation、
 * mutex、dedup、ICE restart）與「signal 存在哪」是兩回事。抽出後：
 *  - 房內連線 → `RoomSignalingTransport`（p2pRooms/{roomId}/signals，行為與重構前一致）。
 *  - 陌生節點（盲信使）→ `RelaySignalingTransport`（relaySignals/{channelId}，不綁房）。
 * manager 只換「signal 讀寫位置」，複用全部硬化過的連線邏輯——不再為 relay 重寫半套 WebRTC。
 *
 * transport 只負責 collection 定位 + 原始讀/寫/清理；dedup / mutex / channelLabel 過濾 /
 * handleSignal 一律留在 manager（那是連線邏輯，非傳輸）。
 */

import {
  collection,
  onSnapshot,
  addDoc,
  query,
  orderBy,
  where,
  limit,
  Timestamp,
  getDocs,
  deleteDoc,
} from 'firebase/firestore';
import { db } from '../../config/firebase';
import { logger } from '../../utils/logger';
import type { RelaySignalingChannel, RelaySignalType } from '../relay/RelaySignaling';

/** 收到的原始 signal 文件（manager 再做 dedup/過濾/handle） */
export interface RawSignalDoc {
  signalId: string;
  from?: string;
  to?: string | null;
  type?: string;
  payload?: unknown;
  channelLabel?: string;
}

export interface SignalingTransport {
  /**
   * 訂閱新增的 signal。cutoffMs = 只看此毫秒之後寫入的（lookback 下限）。
   * onAdded 對每筆「新增」文件呼叫一次（含自己送的——由 manager 過濾）。回傳取消訂閱。
   */
  subscribe(cutoffMs: number, onAdded: (raw: RawSignalDoc) => void): () => void;
  /** 寫一則 signal（manager 已組好 doc，含 from/to/type/payload/createdAt/channelLabel）。 */
  send(data: Record<string, unknown>): Promise<void>;
  /** 清理早於 beforeMs 的舊 signal（best-effort；relay 版可 no-op）。 */
  cleanupOlderThan(beforeMs: number): Promise<void>;
  /** 離開時清掉自己（localUid）這條 channel 送出的 signals（best-effort；relay 版可 no-op）。 */
  cleanupOwn(localUid: string): Promise<void>;
}

/**
 * 依 (roomId, channelLabel) 造一個 SignalingTransport。mesh 每條鄰居連線各造一個
 * （channelLabel 不同）。這是 SDK 的後端注入縫（P2）：預設走 Firestore，第三方可換自架。
 */
export type SignalingFactory = (roomId: string, channelLabel: string) => SignalingTransport;

/**
 * 房內 signaling：p2pRooms/{roomId}/signals。行為與重構前的 P2PConnectionManager
 * 內嵌邏輯逐字一致（同 collection、同 lookback 查詢、同 channelLabel 清理過濾）。
 */
export class RoomSignalingTransport implements SignalingTransport {
  private static readonly SIGNAL_TTL_MS = 5 * 60 * 1000;
  constructor(
    private readonly roomId: string,
    private readonly channelLabel: string
  ) {}

  private signalsRef() {
    return collection(db, 'p2pRooms', this.roomId, 'signals');
  }

  subscribe(cutoffMs: number, onAdded: (raw: RawSignalDoc) => void): () => void {
    // asc 排序確保因果：offer/answer 先、ICE 後。limit 50 同重構前。
    const q = query(
      this.signalsRef(),
      where('createdAt', '>=', Timestamp.fromMillis(cutoffMs)),
      orderBy('createdAt', 'asc'),
      limit(50)
    );
    return onSnapshot(q, (snapshot) => {
      for (const change of snapshot.docChanges()) {
        if (change.type !== 'added') continue;
        onAdded({ ...(change.doc.data() as Record<string, unknown>), signalId: change.doc.id });
      }
    });
  }

  async send(data: Record<string, unknown>): Promise<void> {
    // manager 現以毫秒 number 帶 createdAt（讓其不依賴 firebase）；此處轉 Firestore Timestamp
    // 以維持既有 `where('createdAt','>=',Timestamp)` 查詢語義。
    const createdAt = typeof data.createdAt === 'number'
      ? Timestamp.fromMillis(data.createdAt)
      : data.createdAt;
    const payload = {
      ...data,
      createdAt,
      // Firestore 原生 TTL 只能看明確到期時間；不可直接拿 createdAt 當 TTL，
      // 否則文件一建立就已「到期」。所有新 signal 統一五分鐘後到期。
      expiresAt: Timestamp.fromMillis(Date.now() + RoomSignalingTransport.SIGNAL_TTL_MS),
    };
    await addDoc(this.signalsRef(), payload);
  }

  async cleanupOlderThan(beforeMs: number): Promise<void> {
    try {
      const q = query(
        this.signalsRef(),
        where('createdAt', '<', Timestamp.fromMillis(beforeMs)),
        limit(100)
      );
      const snapshot = await getDocs(q);
      if (snapshot.empty) return;
      // client-side 過濾 channelLabel（避免複合索引）；無 label 的舊格式一律不動——
      // 否則 mesh 下會刪掉其他 pair 還在等的 offer/ICE（隨機分割 mesh）。
      const own = snapshot.docs.filter(
        (d) => (d.data() as Record<string, unknown>).channelLabel === this.channelLabel
      );
      if (own.length === 0) return;
      await Promise.allSettled(own.map((d) => deleteDoc(d.ref)));
      logger.info('[RoomSignalingTransport] Cleaned up old signals', {
        roomId: this.roomId, deletedCount: own.length,
      });
    } catch (err) {
      logger.warn('[RoomSignalingTransport] Failed to cleanup old signals', err);
    }
  }

  async cleanupOwn(localUid: string): Promise<void> {
    try {
      const q = query(this.signalsRef(), where('from', '==', localUid), limit(100));
      const snapshot = await getDocs(q);
      if (snapshot.empty) return;
      // 只刪自己這條 channel 的；無 label 舊格式不動（避免刪到併發的其他連線 signaling）。
      const own = snapshot.docs.filter(
        (d) => (d.data() as Record<string, unknown>).channelLabel === this.channelLabel
      );
      if (own.length === 0) return;
      await Promise.allSettled(own.map((d) => deleteDoc(d.ref)));
      logger.info('[RoomSignalingTransport] Cleaned up session signals on close', {
        roomId: this.roomId, deletedCount: own.length,
      });
    } catch (err) {
      logger.warn('[RoomSignalingTransport] Failed to cleanup session signals', err);
    }
  }
}

/**
 * 陌生節點站級 signaling：relaySignals/{channelId}（ADR-0023 P4-B）。
 * 薄薄包一層 RelaySignalingChannel（已測），對接 SignalingTransport 介面。
 * relay signals 短命（TTL/清理另議），cleanupOlderThan 目前 no-op。
 */
export class RelaySignalingTransport implements SignalingTransport {
  constructor(private readonly channel: RelaySignalingChannel) {}

  subscribe(_cutoffMs: number, onAdded: (raw: RawSignalDoc) => void): () => void {
    // 通道文件需先存在、子集合讀取 rules 靠 get(parent).participants 授權——若在 ensureChannel
    // 寫入落地前就掛 listener，rules 的 get() 拿到 null → permission-denied → listener 直接死掉。
    // 故必須「先 await ensureChannel、再訂閱」。subscribe 介面同步，用 cancelled 旗標接住早退。
    let inner: (() => void) | null = null;
    let cancelled = false;
    void this.channel
      .ensureChannel()
      .then(() => {
        if (cancelled) return;
        inner = this.channel.subscribe((s) =>
          onAdded({ signalId: s.signalId, from: s.from, type: s.type, payload: s.payload })
        );
      })
      .catch((err) => logger.warn('[RelaySignalingTransport] ensureChannel before subscribe failed', { err }));
    return () => {
      cancelled = true;
      inner?.();
    };
  }

  async send(data: Record<string, unknown>): Promise<void> {
    await this.channel.ensureChannel();
    await this.channel.send(data['type'] as RelaySignalType, data['payload'] as Record<string, unknown>);
  }

  async cleanupOlderThan(): Promise<void> {
    /* relay signals 短命；清理策略另議（P4 後續）。 */
  }

  async cleanupOwn(): Promise<void> {
    /* relay signals 短命；離開清理另議（P4 後續）。 */
  }
}
