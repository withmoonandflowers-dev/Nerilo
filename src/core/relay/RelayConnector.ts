/**
 * RelayConnector — 陌生節點站級連線編排（P4-B，ADR-0023）
 *
 * 把 P4-B 的三塊零件串成端到端「連上房間外的中繼節點」：
 *   RelayDirectory 發現 who → RelaySignalingChannel（站級 signaling，不綁房）
 *   → RelaySignalingTransport → P2PConnectionManager → relay-only DataChannel。
 *
 * 兩個角色：
 *   - **主動方**（要中繼幫忙）：connectToRelayNode(strangerUid) → initiator，送 offer。
 *   - **中繼方**（提供服務）：startListening() → 監聽「participants 含我」的 channel，
 *     對每個「非我發起」的來連當 responder（P2PConnectionManager 訂到 offer 自動 answer）。
 *
 * 對稱去重：主動方記下自己發起的 channelId，監聽時略過，避免自己回應自己。
 *
 * 誠實邊界：本編排的「邏輯」可單元測試（deps 注入）；「真的連上」需真實 WebRTC +
 * Firestore + 兩個瀏覽器，屬部署驗證（多節點 E2E），非單元可涵蓋。
 */

import type { ConnectionState } from '../../types';
import type { P2PChannelBus } from '../p2p/P2PChannelBus';
import { P2PManager } from '../p2p/P2PManager';
import { RelaySignalingTransport } from '../p2p/SignalingTransport';
import { RelaySignalingChannel, relayChannelId } from './RelaySignaling';
import { collection, query, where, onSnapshot } from 'firebase/firestore';
import { db } from '../../config/firebase';
import { logger } from '../../utils/logger';

const RELAY_LABEL = 'relay';

/**
 * RelayConnector 對連線的最小需求（供測試注入假件）。
 * initialize() 一步完成整個連線建立：主動方建 DataChannel + 送 offer；中繼方等對端 DataChannel。
 * ——必須用 P2PManager（它建 DataChannel），不能用裸 P2PConnectionManager（無 m-line → ICE 永不起）。
 */
export interface RelayConnLike {
  initialize(): Promise<void>;
  getState(): ConnectionState;
  /** relay DataChannel 的 P2PChannelBus（DataChannel open 前為 null）；courier 協議掛在其上。 */
  getChannelBus(): P2PChannelBus | null;
  close(): Promise<void>;
}

export interface RelayConnectorDeps {
  /** 建連線（預設真 P2PManager，注入 RelaySignalingTransport）。isInitiator 決定主動/中繼角色。 */
  makeConn?: (
    channelId: string,
    localUid: string,
    remoteUid: string,
    isInitiator: boolean
  ) => RelayConnLike;
  /** 監聽「participants 含 localUid」的 relaySignals channel（預設 Firestore query） */
  watchMyChannels?: (
    localUid: string,
    onAdded: (channelId: string, participants: string[]) => void
  ) => () => void;
}

function defaultMakeConn(
  channelId: string,
  localUid: string,
  remoteUid: string,
  isInitiator: boolean
): RelayConnLike {
  const channel = new RelaySignalingChannel(localUid, remoteUid);
  const transport = new RelaySignalingTransport(channel);
  // pseudo roomId = channelId（雙方一致、穩定）；channelLabel='relay'（relay-only 連線）。
  // P2PManager 負責 DataChannel + offer（主動方）／等待對端 DataChannel（中繼方）。
  const mgr = new P2PManager(channelId, localUid, RELAY_LABEL, isInitiator, transport);
  return {
    initialize: () => mgr.initialize(),
    getState: () => mgr.getConnectionManager().getState(),
    getChannelBus: () => mgr.getChannelBus(),
    close: () => mgr.close(),
  };
}

function defaultWatchMyChannels(
  localUid: string,
  onAdded: (channelId: string, participants: string[]) => void
): () => void {
  // array-contains 單欄位過濾，Firestore 自動索引，無需複合索引
  const q = query(collection(db, 'relaySignals'), where('participants', 'array-contains', localUid));
  return onSnapshot(q, (snap) => {
    for (const change of snap.docChanges()) {
      if (change.type !== 'added') continue;
      const participants = (change.doc.data().participants as string[]) ?? [];
      onAdded(change.doc.id, participants);
    }
  });
}

/**
 * H-3：入站連線上限。中繼是志願服務，但「自動應答任何來連」讓任何登入者都能
 * 強迫本節點做 WebRTC 協商（藉 ICE candidate 取得本機 IP），且可重複觸發耗盡
 * RTCPeerConnection 資源。同時服務的陌生來連以此為上界。
 */
const MAX_INBOUND_CONNECTIONS = 16;

/**
 * H-3：同一對端的入站冷卻。rules 已把 channelId 綁成 uid 對（一對只有一條通道），
 * 但通道文件可被 participants 刪除後重建 → 再次觸發 'added'。
 *
 * 刻意取短（5s）：冷卻的安全價值只在「防高頻轟炸」——IP 在首次接觸就已揭露，
 * 拉長視窗並不會多擋住什麼，卻會讓正當的斷線重連被拒。5s 足以擋掉緊迴圈式
 * 重開通道，對真實重連幾乎無感。
 */
const INBOUND_COOLDOWN_MS = 5_000;

export class RelayConnector {
  private readonly makeConn: NonNullable<RelayConnectorDeps['makeConn']>;
  private readonly watchMyChannels: NonNullable<RelayConnectorDeps['watchMyChannels']>;
  /** 自己發起的 channelId，監聽時略過（避免自己回應自己） */
  private readonly initiated = new Set<string>();
  private readonly active = new Map<string, RelayConnLike>();
  /** H-3：入站連線數（只計 responder；主動連出不受上限約束） */
  private inboundCount = 0;
  /** H-3：對端 uid → 最近一次受理入站的時間戳（冷卻用） */
  private readonly lastInboundAt = new Map<string, number>();

  constructor(private readonly localUid: string, deps: RelayConnectorDeps = {}) {
    this.makeConn = deps.makeConn ?? defaultMakeConn;
    this.watchMyChannels = deps.watchMyChannels ?? defaultWatchMyChannels;
  }

  /**
   * 主動連上一個（RelayDirectory 發現的）陌生中繼節點。initiator：initialize + 送 offer。
   * @returns 連線管理器（可查 getState / close）
   */
  // 注意：strangerUid = 對方的 **firebase uid**（RelayAnnouncement.ownerUid，非 nodeId/mesh
  // userId）——relaySignals channel 的 rules 驗 `auth.uid in participants`，故需 firebase uid。
  async connectToRelayNode(strangerUid: string): Promise<RelayConnLike> {
    if (strangerUid === this.localUid) throw new RangeError('不能連自己');
    const channelId = relayChannelId(this.localUid, strangerUid);
    const existing = this.active.get(channelId);
    if (existing) return existing; // 已在連，不重複
    this.initiated.add(channelId);
    const conn = this.makeConn(channelId, this.localUid, strangerUid, true); // initiator
    this.active.set(channelId, conn);
    await conn.initialize(); // 建 DataChannel + 送 offer（P2PManager initiator 路徑）
    return conn;
  }

  /**
   * 中繼方：監聽陌生節點的來連。對每個「participants 含我、非我發起、未在連」的 channel，
   * 建 responder 連線（訂到 offer 會自動 answer）。回傳取消監聽。
   */
  startListening(onIncoming?: (conn: RelayConnLike, remoteUid: string) => void): () => void {
    return this.watchMyChannels(this.localUid, (channelId, participants) => {
      if (this.initiated.has(channelId)) return; // 我發起的，不當 responder
      if (this.active.has(channelId)) return; // 已在處理
      const remoteUid = participants.find((p) => p !== this.localUid);
      if (!remoteUid) return;

      // H-3：入站節流。自動應答是中繼的本職，但不能無上限——否則任何登入者都能
      // 強迫本節點協商 WebRTC 並取得 IP，或以量耗盡資源。
      if (this.inboundCount >= MAX_INBOUND_CONNECTIONS) {
        logger.warn('[RelayConnector] 入站已達上限，略過此來連', {
          channelId, remoteUid, max: MAX_INBOUND_CONNECTIONS,
        });
        return;
      }
      const last = this.lastInboundAt.get(remoteUid);
      if (last !== undefined && Date.now() - last < INBOUND_COOLDOWN_MS) {
        logger.warn('[RelayConnector] 同一對端仍在冷卻期，略過此來連', { channelId, remoteUid });
        return;
      }
      this.lastInboundAt.set(remoteUid, Date.now());

      const conn = this.makeConn(channelId, this.localUid, remoteUid, false); // responder
      this.active.set(channelId, conn);
      this.inboundCount++;
      void conn.initialize().then(
        () => onIncoming?.(conn, remoteUid),
        (err) => logger.warn('[RelayConnector] responder initialize failed', { channelId, err })
      );
    });
  }

  /** 關閉所有 relay 連線（離開/清理） */
  async closeAll(): Promise<void> {
    await Promise.all([...this.active.values()].map((c) => c.close().catch(() => undefined)));
    this.active.clear();
    this.initiated.clear();
    this.inboundCount = 0; // H-3：名額隨連線關閉一併回收
    // lastInboundAt 刻意保留：冷卻是防重複探測，不應因自己 closeAll 就歸零。
  }

  /** 目前 relay 連線數（監控/測試） */
  activeCount(): number {
    return this.active.size;
  }

  /** 目前所有 relay 連線的狀態（監控/E2E 觀察是否 connected） */
  states(): ConnectionState[] {
    return [...this.active.values()].map((c) => c.getState());
  }
}
