import type { GossipMessage } from '../../types';
import { IdentityManager } from './IdentityManager';
import { SecurityManager } from './SecurityManager';
import { MeshTopologyManager } from './MeshTopologyManager';
import type { MeshConnection } from './MeshConnection';
import { computeDigest, normalizeDigest, peerLacks } from './antiEntropy';
import type { IGossipPersistence } from './GossipPersistence';
import {
  encryptRecordContent,
  decryptRecordContent,
  isEncryptedContent,
} from './RecordCrypto';
import type { PeerScoring } from '../relay/PeerScoring';
import { logger } from '../../utils/logger';

/**
 * Gossip 訊息處理器
 * 負責訊息的發送、接收、轉發、去重與 anti-entropy 對帳（見 antiEntropy.ts）
 */
export class GossipMessageHandler {
  private seq = 0;
  /**
   * 訊息 store：senderId → (seq → 已簽名訊息)。房間會話生命週期。
   * 同時是去重的正準依據（(senderId, seq) 是訊息身分）與對帳補送的資料源。
   */
  private store: Map<string, Map<number, GossipMessage>> = new Map();
  /** 每 sender 淘汰後推進的 floor：digest 據此宣告「floor 前的缺口不用回補」 */
  private floors: Map<string, number> = new Map();
  /**
   * 驗簽中的 (senderId:seq) 預佔。去重判定必須在任何 await 之前完成，
   * 否則兩個鄰居同時遞同一則訊息，會在驗簽 await 期間雙雙通過檢查而重複 notify。
   */
  private inflight: Set<string> = new Set();
  private sendRateLimiter: Map<string, number[]> = new Map();
  private messageListeners: Set<(message: GossipMessage) => void> = new Set();
  private readonly MAX_MESSAGES_PER_SECOND = 10;
  /** 每 sender store 上限：超過淘汰最舊 seq 並推進 floor（聊天會話遠低於此） */
  private readonly MAX_STORE_PER_SENDER = 500;
  /** 單輪 digest 補送上限：限制突發頻寬；剩餘缺口由後續輪次補齊 */
  private readonly MAX_FILL_PER_ROUND = 200;

  constructor(
    private roomId: string,
    private userId: string,
    private identityManager: IdentityManager,
    private securityManager: SecurityManager,
    private topologyManager: MeshTopologyManager,
    private peerScoring: PeerScoring | null = null,
    /** 複本持久化（ADR-0023 P1）；null = 記憶體模式（行為同 P1 之前） */
    private persistence: IGossipPersistence | null = null
  ) {}

  // ── 內容金鑰（ADR-0023 P2-②）─────────────────────────────────────────────
  /** 房間內容金鑰；null = 尚未就緒 → 收送退明文相容（行為同 P2 之前） */
  private contentKey: CryptoKey | null = null;
  /** 金鑰 epoch（輪替遞增；寫入密文信封供解密端選鑰） */
  private keyEpoch = 0;

  /**
   * 設定/清除房間內容金鑰。金鑰就緒後：送出時加密 content（簽章覆蓋密文，
   * 盲信使可存可驗不可解）、顯示前解密。store/轉發/對帳一律保持密文原封。
   * 分發協議（keyx 紀錄）為 P2-②b；此處只負責「有鑰就用」。
   */
  setContentKey(key: CryptoKey | null, epoch = 0): void {
    this.contentKey = key;
    this.keyEpoch = epoch;
  }

  /**
   * 從持久複本重生（ADR-0023 P1）：載入紀錄與 floors 進記憶體 store。
   * 必須在任何收送之前呼叫。失敗非致命——退回記憶體模式（Safari 隱私模式等）。
   */
  async hydrate(): Promise<void> {
    if (!this.persistence) return;
    try {
      const { records, floors } = await this.persistence.loadRoom(this.roomId);
      for (const { senderId, floor } of floors) {
        this.floors.set(senderId, floor);
      }
      let loaded = 0;
      for (const msg of records) {
        if (
          typeof msg?.senderId !== 'string' || msg.senderId.length === 0 ||
          typeof msg?.seq !== 'number' || !Number.isInteger(msg.seq) || msg.seq < 1
        ) continue;
        if (msg.seq < (this.floors.get(msg.senderId) ?? 1)) continue;
        this.storePut(msg, /* persist */ false); // 來自持久層，不回寫
        loaded++;
      }
      // 自己的 seq 水位以 reserveSeq 為真相；此處僅對齊記憶體值供無持久化路徑参考
      const own = this.store.get(this.userId);
      if (own) for (const s of own.keys()) if (s > this.seq) this.seq = s;
      logger.info('[GossipMessageHandler] hydrated from replica', {
        roomId: this.roomId, records: loaded, floors: this.floors.size,
      });
    } catch (err) {
      logger.warn('[GossipMessageHandler] hydrate failed — memory-only mode', {
        roomId: this.roomId, err,
      });
    }
  }

  /**
   * 發送訊息
   * @param messageId 應用層訊息 id（樂觀顯示同款）；帶上讓收端跨傳輸路徑去重
   */
  async sendMessage(
    content: string,
    messageId?: string,
    channel?: GossipMessage['channel']
  ): Promise<void> {
    // Rate limiting
    if (!this.checkSendRate(this.userId)) {
      throw new Error('Rate limit exceeded');
    }

    // reserve-then-send（ADR-0023 P1）：先在持久層原子保留 seq 再送。
    // 重載/重進後 seq 續增永不重用 → 不會與對方複本的舊 seq 碰撞被當重複丟棄。
    // crash 於保留與送出之間只留 seq 空洞，anti-entropy 容忍。
    if (this.persistence) {
      try {
        this.seq = await this.persistence.reserveSeq(this.roomId, this.userId);
      } catch (err) {
        logger.warn('[GossipMessageHandler] reserveSeq failed, falling back to memory seq', {
          roomId: this.roomId, err,
        });
        this.seq++;
      }
    } else {
      this.seq++;
    }

    // 從拓撲管理器讀取動態 gossip 設定
    const gossipConfig = this.topologyManager.getGossipConfig();

    // 內容密文化（P2-②）：金鑰就緒才加密，否則明文相容。
    // 加密在簽章「之前」→ 簽章覆蓋密文，任何人（含盲信使）可驗真偽而無需金鑰。
    let wireContent = content;
    if (this.contentKey) {
      try {
        wireContent = await encryptRecordContent(content, this.contentKey, this.keyEpoch);
      } catch (err) {
        // 加密失敗不得默默送明文（會洩漏）——直接拋，讓上層標記傳送失敗
        logger.error('[GossipMessageHandler] content encryption failed', {
          roomId: this.roomId, err,
        });
        throw new Error('content encryption failed');
      }
    }

    // 建立訊息（channel 缺省 = 'chat'；游戲事件帶 'game'，同管線同保證）
    const message: Omit<GossipMessage, 'signature'> = {
      roomId: this.roomId,
      senderId: this.userId,
      pubKey: await this.identityManager.exportPublicKey(),
      seq: this.seq,
      timestamp: Date.now(),
      content: wireContent,
      ttl: gossipConfig.ttl,
      ...(messageId !== undefined ? { messageId } : {}),
      ...(channel !== undefined ? { channel } : {}),
    };

    // 簽名
    const signature = await this.securityManager.signMessage(
      message,
      this.identityManager.getPrivateKey()
    );

    const signedMessage: GossipMessage = { ...message, signature };

    // 先入 store 再送：即使當下所有鄰居都送失敗，訊息仍在 store，
    // 之後的 digest 對帳會把它補到所有 peer（liveness 不依賴此刻的連線狀態）。
    this.storePut(signedMessage);

    // 傳給隨機選的鄰居（fanout 由 AdaptiveTopologyManager 決定）。
    // 只選「已連上」的：對半開/未就緒連線 send 會卡 waitForReady（最長 30s），
    // 讓整個 sendMessage 的 await 拖住呼叫端（例如 ChatPage 排在後面的備援橋接）。
    // 未連上的鄰居本來就送不到，之後由 anti-entropy 對帳補上。
    const neighbors = this.topologyManager
      .getNeighbors()
      .filter((n) => n.getState() === 'connected');
    const selected = this.selectRandomNeighbors(neighbors, gossipConfig.fanout);

    // 並行送出：neighbor.send 會等該連線就緒（最長 30s），逐一 await 會讓
    // 一個未就緒的鄰居擋住其他所有人（head-of-line blocking）
    await Promise.all(
      selected.map(async (neighbor) => {
        try {
          await neighbor.send(signedMessage);
        } catch (error) {
          logger.warn('[GossipMessageHandler] Failed to send to neighbor', {
            roomId: this.roomId,
            neighborId: neighbor.getId(),
            error,
          });
        }
      })
    );

    logger.info('[GossipMessageHandler] sent', {
      roomId: this.roomId,
      seq: this.seq,
      fanoutTargets: selected.map((n) => n.getId()),
      neighborCount: neighbors.length,
    });

    // 註：送出時「不」回吐給本地監聽器。自己訊息的顯示由應用層負責
    // （MeshChatService 樂觀更新，id 與 ChatPage 一致）。gossip 層在此回吐會用
    // 另一套 id（userId-seq）造成自訊息重複。收訊路徑仍照常 notify。
  }

  /**
   * 處理接收到的訊息
   */
  async handleReceivedMessage(
    message: GossipMessage,
    fromNeighbor: string
  ): Promise<void> {
    // 灰名單檢查：跳過低信譽 peer 的訊息
    if (this.peerScoring?.isGraylisted(fromNeighbor)) {
      return;
    }

    // 網路輸入形狀檢查（seq/senderId/ttl 都可能是惡意或畸形值）
    if (
      typeof message.senderId !== 'string' || message.senderId.length === 0 ||
      typeof message.seq !== 'number' || !Number.isInteger(message.seq) || message.seq < 1
    ) {
      return;
    }
    if (typeof message.ttl !== 'number' || !Number.isFinite(message.ttl)) {
      logger.warn('[GossipMessageHandler] Invalid TTL type', {
        roomId: this.roomId,
        senderId: message.senderId,
        ttl: message.ttl,
      });
      return;
    }

    // (senderId, seq) 同步去重 + 預佔（必須在任何 await 之前，見 inflight 註解）。
    // 舊實作在此拒收「seq <= 上次見過」的訊息，把 anti-entropy 補送的較早訊息
    // 當重放丟掉，造成永久遺失——真正的重放是「同 (senderId, seq) 已在 store」。
    const key = `${message.senderId}:${message.seq}`;
    if (this.hasMessage(message.senderId, message.seq) || this.inflight.has(key)) {
      this.peerScoring?.recordDuplicate(fromNeighbor);
      return; // 已處理過
    }
    // floor 前的區間已淘汰，不再收
    if (message.seq < (this.floors.get(message.senderId) ?? 1)) {
      return;
    }

    this.inflight.add(key);
    try {
      // 驗證簽名。maxAgeMs: null——anti-entropy 補送與首次洪泛在線路上無法
      // 區分（補送即原始已簽名訊息重送），時效窗會把補給遲到者的 >5 分鐘
      // 舊訊息拒掉、造成永久遺失。本路徑的重放防護由上方 (senderId, seq)
      // 去重 + floor 承擔；代價是跨會話重放不再受時效窗限制（新會話 store
      // 為空），屬已記錄的殘留風險，見 docs/QA-REPORT-chat.md。
      const publicKey = await this.securityManager.importPublicKey(message.pubKey);
      const isValid = await this.securityManager.verifyMessage(message, publicKey, {
        maxAgeMs: null,
      });

      if (!isValid) {
        logger.warn('[GossipMessageHandler] Invalid signature', {
          roomId: this.roomId,
          senderId: message.senderId,
          seq: message.seq,
        });
        this.peerScoring?.recordInvalidMessage(fromNeighbor);
        return; // 簽名無效
      }

      // 驗證 pubKey 對應 senderId（#16：防止攻擊者用自己的 key 偽造其他人的 senderId）
      if (this.identityManager) {
        const derivedId = await this.identityManager.deriveUserId(publicKey);
        if (derivedId !== message.senderId) {
          logger.warn('[GossipMessageHandler] Sender identity mismatch (possible spoofing)', {
            roomId: this.roomId,
            claimed: message.senderId,
            derived: derivedId,
          });
          this.peerScoring?.recordInvalidMessage(fromNeighbor);
          return;
        }
      }

      // 入 store（此後 digest 會向鄰居宣告持有，缺的 peer 能從我這補到）
      this.storePut(message);

      // 記錄有效訊息投遞（提升 peer 信譽）
      this.peerScoring?.recordDelivery(fromNeighbor);

      logger.info('[GossipMessageHandler] accepted', {
        roomId: this.roomId,
        senderId: message.senderId,
        seq: message.seq,
        from: fromNeighbor,
        ttl: message.ttl,
      });

      // 顯示訊息。注意：顯示不受 ttl 限制——ttl 只限制主動洪泛半徑，
      // 訊息既已到達（含 anti-entropy 補送），對使用者就必須恰好一次呈現。
      // 密文化（P2-②）：僅「顯示副本」解密；store/轉發/對帳沿用密文原封（盲信使相容）。
      this.notifyMessageListeners(await this.toDisplayMessage(message));

      // 轉發（建立副本以避免修改傳入物件）；ttl 耗盡則不轉發，缺口由對帳補
      if (message.ttl > 0) {
        const forwarded: GossipMessage = { ...message, ttl: message.ttl - 1 };
        await this.forwardMessage(forwarded, fromNeighbor);
      }
    } finally {
      this.inflight.delete(key);
    }
  }

  /** 是否已持有 (senderId, seq) */
  private hasMessage(senderId: string, seq: number): boolean {
    return this.store.get(senderId)?.has(seq) ?? false;
  }

  /**
   * 寫入 store；超過每 sender 上限時淘汰最舊 seq 並推進 floor。
   * @param persist 寫入持久複本（hydrate 回灌時傳 false 避免無謂回寫）。
   *   持久寫入為非阻塞 best-effort：最壞情況重載後缺一筆「已顯示」紀錄，
   *   由任一持有的成員經對帳補回（複本互補正是本架構的保證）。
   */
  private storePut(message: GossipMessage, persist = true): void {
    let seqs = this.store.get(message.senderId);
    if (!seqs) {
      seqs = new Map();
      this.store.set(message.senderId, seqs);
    }
    if (seqs.has(message.seq)) return;
    seqs.set(message.seq, message);

    if (persist && this.persistence) {
      void this.persistence.saveRecord(this.roomId, message).catch((err) => {
        logger.warn('[GossipMessageHandler] saveRecord failed', { roomId: this.roomId, err });
      });
    }

    while (seqs.size > this.MAX_STORE_PER_SENDER) {
      let oldest = Infinity;
      for (const s of seqs.keys()) {
        if (s < oldest) oldest = s;
      }
      seqs.delete(oldest);
      const floor = this.floors.get(message.senderId) ?? 1;
      const newFloor = Math.max(floor, oldest + 1);
      this.floors.set(message.senderId, newFloor);
      if (this.persistence) {
        void this.persistence
          .evictRecord(this.roomId, message.senderId, oldest, newFloor)
          .catch((err) => {
            logger.warn('[GossipMessageHandler] evictRecord failed', { roomId: this.roomId, err });
          });
      }
    }
  }

  /**
   * anti-entropy 週期：把本地 digest 送給一個已連上的鄰居。
   * 對方收到後（handleDigest）會把我缺的訊息補送過來；反向亦然。
   */
  async sendDigestTo(neighbor: MeshConnection): Promise<void> {
    if (this.store.size === 0) return; // 沒東西可宣告
    try {
      await neighbor.sendDigest(computeDigest(this.store, this.floors));
    } catch (error) {
      logger.warn('[GossipMessageHandler] Failed to send digest', {
        roomId: this.roomId,
        neighborId: neighbor.getId(),
        error,
      });
    }
  }

  /**
   * 處理鄰居送來的 digest：比對本地 store，把「我有、對方缺」的訊息補送過去。
   * 補送的是原始已簽名訊息，收端走一般 handleReceivedMessage（驗簽 + 去重 + 顯示）。
   */
  async handleDigest(rawDigest: unknown, neighbor: MeshConnection): Promise<void> {
    const digest = normalizeDigest(rawDigest);
    if (!digest) {
      logger.warn('[GossipMessageHandler] Malformed digest ignored', {
        roomId: this.roomId,
        neighborId: neighbor.getId(),
      });
      return;
    }

    const fills: GossipMessage[] = [];
    outer: for (const [senderId, seqs] of this.store) {
      for (const [seq, msg] of seqs) {
        if (peerLacks(digest, senderId, seq)) {
          fills.push(msg);
          if (fills.length >= this.MAX_FILL_PER_ROUND) break outer;
        }
      }
    }
    // 穩定順序利於除錯；正確性不依賴順序（收端以 (senderId, seq) 去重）
    fills.sort((a, b) =>
      a.senderId === b.senderId ? a.seq - b.seq : a.senderId.localeCompare(b.senderId)
    );

    if (fills.length > 0) {
      logger.info('[GossipMessageHandler] anti-entropy fill', {
        roomId: this.roomId,
        to: neighbor.getId(),
        fills: fills.map((m) => `${m.senderId.slice(0, 8)}:${m.seq}`),
      });
    }

    for (const msg of fills) {
      try {
        await neighbor.send(msg);
      } catch (error) {
        logger.warn('[GossipMessageHandler] anti-entropy fill failed', {
          roomId: this.roomId,
          neighborId: neighbor.getId(),
          error,
        });
        return; // 連線壞了就停，下一輪 digest 再補
      }
    }
  }

  /**
   * 轉發訊息
   */
  private async forwardMessage(
    message: GossipMessage,
    excludeNeighbor: string
  ): Promise<void> {
    const gossipConfig = this.topologyManager.getGossipConfig();
    // 同 sendMessage：只轉發給已連上的鄰居，避免半開連線拖住整個轉發
    const neighbors = this.topologyManager.getNeighbors()
      .filter(n => n.getId() !== excludeNeighbor && n.getState() === 'connected');

    const selected = this.selectRandomNeighbors(neighbors, gossipConfig.fanout);

    // 並行轉發，理由同 sendMessage（避免 head-of-line blocking）
    await Promise.all(
      selected.map(async (neighbor) => {
        try {
          await neighbor.send(message);
        } catch (error) {
          logger.warn('[GossipMessageHandler] Failed to forward message', {
            roomId: this.roomId,
            neighborId: neighbor.getId(),
            error,
          });
        }
      })
    );
  }

  /**
   * 檢查發送速率
   */
  private checkSendRate(senderId: string): boolean {
    const now = Date.now();
    const timestamps = this.sendRateLimiter.get(senderId) || [];
    const recent = timestamps.filter(ts => now - ts < 1000);

    if (recent.length >= this.MAX_MESSAGES_PER_SECOND) {
      return false; // 超過速率限制
    }

    recent.push(now);
    this.sendRateLimiter.set(senderId, recent);
    return true;
  }

  /**
   * 隨機選擇鄰居
   */
  private selectRandomNeighbors(
    neighbors: MeshConnection[],
    count: number
  ): MeshConnection[] {
    const shuffled = [...neighbors].sort(() => Math.random() - 0.5);
    return shuffled.slice(0, Math.min(count, neighbors.length));
  }

  /**
   * 監聽訊息
   */
  onMessage(listener: (message: GossipMessage) => void): () => void {
    this.messageListeners.add(listener);
    return () => {
      this.messageListeners.delete(listener);
    };
  }

  /**
   * 通知監聽器
   */
  /**
   * 產生「顯示用副本」：content 是密文且持有對應金鑰 → 解密副本；明文 → 原封；
   * 密文但無金鑰（尚未補齊 keyx）→ 佔位字串誠實呈現（如同備援解不開的路徑）。
   * 不修改傳入物件——store/轉發/對帳要的是密文原封。
   */
  private async toDisplayMessage(message: GossipMessage): Promise<GossipMessage> {
    if (!isEncryptedContent(message.content)) return message; // 明文相容路徑
    if (!this.contentKey) {
      return { ...message, content: '[🔒 訊息已加密，尚未取得金鑰]' };
    }
    try {
      const plain = await decryptRecordContent(message.content, this.contentKey);
      return { ...message, content: plain };
    } catch (err) {
      logger.warn('[GossipMessageHandler] decrypt for display failed', {
        roomId: this.roomId, senderId: message.senderId, seq: message.seq, err,
      });
      return { ...message, content: '[🔒 無法解密此訊息]' };
    }
  }

  private notifyMessageListeners(message: GossipMessage): void {
    this.messageListeners.forEach(listener => {
      try {
        listener(message);
      } catch (error) {
        logger.error('[GossipMessageHandler] Error in message listener', {
          roomId: this.roomId,
          error,
        });
      }
    });
  }
}
