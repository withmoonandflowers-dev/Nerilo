import type { GossipMessage } from '../../types';
import { IdentityManager } from './IdentityManager';
import { SecurityManager } from './SecurityManager';
import { MeshTopologyManager } from './MeshTopologyManager';
import type { MeshConnection } from './MeshConnection';
import { computeDigest, normalizeDigest, peerLacks } from './antiEntropy';
import type { NormalizedDigest } from './antiEntropy';
import type { IGossipPersistence } from './GossipPersistence';
import { RoomContentKeyRing } from './RoomContentKeys';
import type { PeerScoring } from '../relay/PeerScoring';
import { logger } from '../../utils/logger';

/**
 * Gossip 訊息處理器
 * 負責訊息的發送、接收、轉發、去重與 anti-entropy 對帳（見 antiEntropy.ts）
 */
export class GossipMessageHandler {
  private seq = 0;
  /**
   * 本會話代（Spec 009）：首次發送時惰性配發（persistence.reserveSessionEpoch，
   * 記憶體模式以 Date.now() 種出），同會話固定、簽進自己的每則訊息。
   */
  private sessionEpoch: number | null = null;
  /**
   * 分代訊息 store：senderId → sessionEpoch → (seq → 已簽名訊息)。
   * 去重的正準依據（(senderId, sessionEpoch, seq) 是訊息身分）與對帳補送的資料源。
   * 只有各 sender 的現行代桶會被宣告與補送；舊代桶於採納新代時剪除（inert 歷史）。
   */
  private store: Map<string, Map<number, Map<number, GossipMessage>>> = new Map();
  /** 分代 floor：senderId → epoch → floor。digest 據此宣告「floor 前的缺口不用回補」 */
  private floors: Map<string, Map<number, number>> = new Map();
  /**
   * per-sender 已驗證現行代（Spec 009 §4.5）：只在「通過驗簽＋身分綁定」的訊息
   * 上觀察到更高代才推進（不可偽造）。低於現行代的訊息一律完全拒收。
   */
  private acceptedEpochs: Map<string, number> = new Map();
  /**
   * 驗簽中的 (senderId:epoch:seq) 預佔。去重判定必須在任何 await 之前完成，
   * 否則兩個鄰居同時遞同一則訊息，會在驗簽 await 期間雙雙通過檢查而重複 notify。
   */
  private inflight: Set<string> = new Set();
  /** 版本不合通知（Spec 009 §4.7）：收到缺 sessionEpoch 的 v1 gossip 訊息＝舊版確證 */
  private protocolMismatchListeners: Set<(fromNeighbor: string) => void> = new Set();
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
  ) {
    this.contentKeys = new RoomContentKeyRing(roomId, userId);
  }

  // ── 內容金鑰（ADR-0023 P2-②；實作在 RoomContentKeys.ts，此處薄委派保持公開 API）──
  private contentKeys: RoomContentKeyRing;

  /**
   * 加入/設定一把房間內容金鑰到金鑰環。key=null 清空整個環（退明文）。
   * 送出時加密 content（簽章覆蓋密文，盲信使可存可驗不可解）、顯示前解密；
   * store/轉發/對帳一律保持密文原封。分發協議（keyx 紀錄）見 RoomContentKeyRing。
   */
  setContentKey(key: CryptoKey | null, epoch = 0): void {
    this.contentKeys.setContentKey(key, epoch);
  }

  /** 注入本機 ECDH 私鑰，啟用 keyx 消費（開出封給自己的房間金鑰）。 */
  setKeyxPrivateKey(ecdhPrivateKey: CryptoKey | null): void {
    this.contentKeys.setKeyxPrivateKey(ecdhPrivateKey);
  }

  /** 送出時是否會加密。false = 目前送出走明文（ADR-0026 R2）。 */
  hasSendKey(): boolean {
    return this.contentKeys.hasSendKey();
  }

  /** 金鑰環中已知最高（房間金鑰）epoch；供產生方交接時單調遞增。 */
  getMaxKnownEpoch(): number {
    return this.contentKeys.getMaxKnownEpoch();
  }

  /**
   * 用目前送出金鑰把明文加成 RecordCrypto 信封字串，供 Firestore 備援層使用
   * （ADR-0023 P2-③）。無金鑰回 null——呼叫端據此「不送」，而非退明文洩漏。
   */
  async encryptForFallback(plaintext: string): Promise<string | null> {
    return this.contentKeys.encryptOutgoing(plaintext);
  }

  /** 解 Firestore 備援層的 RecordCrypto 信封字串 → 明文。無鑰拋錯，呼叫端顯示佔位。 */
  async decryptForFallback(envelope: string): Promise<string> {
    return this.contentKeys.decryptEnvelope(envelope);
  }

  /**
   * 從持久複本重生（ADR-0023 P1）：載入紀錄與 floors 進記憶體 store。
   * 必須在任何收送之前呼叫。失敗非致命——退回記憶體模式（Safari 隱私模式等）。
   */
  async hydrate(): Promise<void> {
    if (!this.persistence) return;
    try {
      const { records, floors, acceptedEpochs } = await this.persistence.loadRoom(this.roomId);
      for (const { senderId, epoch, floor } of floors) {
        let byEpoch = this.floors.get(senderId);
        if (!byEpoch) this.floors.set(senderId, (byEpoch = new Map()));
        byEpoch.set(epoch, floor);
      }
      for (const { senderId, epoch } of acceptedEpochs) {
        if (Number.isSafeInteger(epoch) && epoch >= 1) this.acceptedEpochs.set(senderId, epoch);
      }
      let loaded = 0;
      for (const msg of records) {
        if (
          typeof msg?.senderId !== 'string' || msg.senderId.length === 0 ||
          typeof msg?.seq !== 'number' || !Number.isInteger(msg.seq) || msg.seq < 1
        ) continue;
        // legacy（v1 落盤、無 sessionEpoch）→ 0 代桶：僅本機保留，永不宣告/補送（Spec 009 §4.8）
        const epoch = this.epochOf(msg);
        if (msg.seq < (this.floors.get(msg.senderId)?.get(epoch) ?? 1)) continue;
        this.storePut(msg, /* persist */ false); // 來自持久層，不回寫
        loaded++;
      }
      // 自己的 seq 水位以 reserveSeq 為真相；此處僅對齊記憶體值供無持久化路徑参考
      const own = this.store.get(this.userId);
      if (own) {
        for (const seqs of own.values()) {
          for (const s of seqs.keys()) if (s > this.seq) this.seq = s;
        }
      }
      logger.info('[GossipMessageHandler] hydrated from replica', {
        roomId: this.roomId, records: loaded, floors: this.floors.size,
        acceptedEpochs: this.acceptedEpochs.size,
      });
    } catch (err) {
      logger.warn('[GossipMessageHandler] hydrate failed — memory-only mode', {
        roomId: this.roomId, err,
      });
    }
  }

  /** 訊息的分代桶：合法 sessionEpoch（safe integer ≥1）即該代，否則 0（legacy） */
  private epochOf(message: GossipMessage): number {
    return Number.isSafeInteger(message.sessionEpoch) && message.sessionEpoch >= 1
      ? message.sessionEpoch
      : 0;
  }

  /**
   * 確保本會話代已配發（Spec 009 §4.4，比照 reserveSeq 的 reserve-then-send）。
   * 每會話一次；記憶體模式與持久失敗退 Date.now()（時鐘下限保證跨重載單調）。
   */
  private async ensureSessionEpoch(): Promise<number> {
    if (this.sessionEpoch !== null) return this.sessionEpoch;
    let reserved: number;
    if (this.persistence) {
      try {
        reserved = await this.persistence.reserveSessionEpoch(this.roomId, this.userId);
      } catch (err) {
        logger.warn('[GossipMessageHandler] reserveSessionEpoch failed, falling back to Date.now()', {
          roomId: this.roomId, errName: (err as Error)?.name,
        });
        reserved = Date.now();
      }
    } else {
      reserved = Date.now();
    }
    // 防禦：hydrate 到的自身現行代不可能高於新配發代（配發取 max(persisted, now)），
    // 但若持久層異常仍要維持單調——自己的新代必須嚴格高於任何已知舊代。
    const prev = this.acceptedEpochs.get(this.userId) ?? 0;
    this.sessionEpoch = reserved > prev ? reserved : prev + 1;
    // 自己的現行代與收端語義一致（＝最後實際簽出的代），持久化讓重載後、尚未在
    // 新會話發言前，上一會話的自簽紀錄仍可補他人；一旦新會話發言即換代剪除。
    this.adoptEpoch(this.userId, this.sessionEpoch);
    return this.sessionEpoch;
  }

  /**
   * 監聽協議版本不合證據（Spec 009 §4.7）：收到缺 sessionEpoch 的 gossip 訊息
   * ＝對端為 v1 舊版的確證。上層據此提示「請雙方更新」，不靜默降級。
   */
  onProtocolMismatch(listener: (fromNeighbor: string) => void): () => void {
    this.protocolMismatchListeners.add(listener);
    return () => {
      this.protocolMismatchListeners.delete(listener);
    };
  }

  private notifyProtocolMismatch(fromNeighbor: string): void {
    this.protocolMismatchListeners.forEach((listener) => {
      try {
        listener(fromNeighbor);
      } catch (error) {
        logger.error('[GossipMessageHandler] Error in protocol mismatch listener', {
          roomId: this.roomId, error,
        });
      }
    });
  }

  /**
   * 發送訊息
   * @param messageId 應用層訊息 id（樂觀顯示同款）；帶上讓收端跨傳輸路徑去重
   */
  async sendMessage(
    content: string,
    messageId?: string,
    channel?: GossipMessage['channel'],
    timestamp?: number
  ): Promise<void> {
    // Rate limiting
    if (!this.checkSendRate(this.userId, channel ?? 'chat')) {
      throw new Error('Rate limit exceeded');
    }

    // 本會話代（Spec 009）：首次發送時配發，之後同會話固定
    const sessionEpoch = await this.ensureSessionEpoch();

    // reserve-then-send（ADR-0023 P1）：先在持久層原子保留 seq 再送。
    // 重載/重進後 seq 續增永不重用 → 不會與對方複本的舊 seq 碰撞被當重複丟棄。
    // crash 於保留與送出之間只留 seq 空洞，anti-entropy 容忍。
    if (this.persistence) {
      try {
        this.seq = await this.persistence.reserveSeq(this.roomId, this.userId);
      } catch (err) {
        logger.warn('[GossipMessageHandler] reserveSeq failed, falling back to memory seq', {
          roomId: this.roomId,
          errName: (err as Error)?.name,
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
    // keyx 通道例外：其 content 本身就是（成對 ECDH 封裝的）金鑰分發紀錄，
    // 不可用房間金鑰再加密（否則要有房間金鑰才能讀房間金鑰，循環）。
    let wireContent = content;
    if (channel !== 'keyx' && this.contentKeys.hasSendKey()) {
      let encrypted: string | null = null;
      try {
        encrypted = await this.contentKeys.encryptOutgoing(content);
      } catch (err) {
        // 加密失敗不得默默送明文（會洩漏）——直接拋，讓上層標記傳送失敗
        logger.error('[GossipMessageHandler] content encryption failed', {
          roomId: this.roomId, err,
        });
        throw new Error('content encryption failed');
      }
      if (encrypted === null) throw new Error('content encryption failed');
      wireContent = encrypted;
    }

    // 建立訊息（channel 缺省 = 'chat'；游戲事件帶 'game'，同管線同保證）
    const message: Omit<GossipMessage, 'signature'> = {
      roomId: this.roomId,
      senderId: this.userId,
      pubKey: await this.identityManager.exportPublicKey(),
      seq: this.seq,
      sessionEpoch,
      // 呼叫端可帶入 timestamp，讓寄件端本機回音與線上複本共用同一時戳（已讀水位跨端比對需
      // 同一 orderKey；否則本機另取 Date.now() 會與線上值分歧）。未帶則自取。
      timestamp: timestamp ?? Date.now(),
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
    // sessionEpoch 形狀（Spec 009 §4.3）：缺欄位或非法一律整則拒收——缺欄位且其餘
    // 形狀完好＝v1 舊版節點的確證，通知版本不合（fail-visible，不靜默分裂）。
    if (!Number.isSafeInteger(message.sessionEpoch) || message.sessionEpoch < 1) {
      logger.warn('[GossipMessageHandler] Missing/invalid sessionEpoch — legacy peer?', {
        roomId: this.roomId,
        senderId: message.senderId,
        seq: message.seq,
        from: fromNeighbor,
      });
      this.notifyProtocolMismatch(fromNeighbor);
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

    // 現行代門檻（Spec 009 §4.5，Q6 口徑）：低於已知現行代的訊息＝舊會話重放，
    // 完全拒收（不入 store、不上 UI、不轉發）。簽章本身合法，故計 duplicate
    // 而非 invalid——計 invalid 會讓攻擊者藉重放他人合法訊息毒化無辜轉發者信譽。
    const accepted = this.acceptedEpochs.get(message.senderId);
    if (accepted !== undefined && message.sessionEpoch < accepted) {
      this.peerScoring?.recordDuplicate(fromNeighbor);
      return;
    }

    // (senderId, epoch, seq) 同步去重 + 預佔（必須在任何 await 之前，見 inflight 註解）。
    // 去重鍵分代（Spec 009）：舊代的 (seq) 不可能佔住新代同 seq 的槽位。
    // 亂序較早 seq（同代 anti-entropy 補送）仍照常接受——真正的重複是
    // 「同 (senderId, epoch, seq) 已在 store」。
    const key = `${message.senderId}:${message.sessionEpoch}:${message.seq}`;
    if (
      this.hasMessage(message.senderId, message.sessionEpoch, message.seq) ||
      this.inflight.has(key)
    ) {
      this.peerScoring?.recordDuplicate(fromNeighbor);
      return; // 已處理過
    }
    // 該代 floor 前的區間已淘汰，不再收
    if (message.seq < (this.floors.get(message.senderId)?.get(message.sessionEpoch) ?? 1)) {
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

      // 採納現行代（Spec 009 §4.5）：只有通過驗簽＋身分綁定的更高代才推進——
      // 攻擊者無 sender 私鑰即無法推高任何 sender 的代。
      const acceptedNow = this.acceptedEpochs.get(message.senderId);
      if (acceptedNow === undefined || message.sessionEpoch > acceptedNow) {
        this.adoptEpoch(message.senderId, message.sessionEpoch);
      } else if (message.sessionEpoch < acceptedNow) {
        // 驗簽 await 期間另一則訊息已推進現行代 → 本則已成舊代，拒收
        this.peerScoring?.recordDuplicate(fromNeighbor);
        return;
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

      // 通道分流（P2-②c）：keyx 是金鑰分發紀錄，不進聊天顯示——消費它（開出封給
      // 自己的房間金鑰 → 加入金鑰環）。它照樣入 store／轉發／對帳（key-as-record：
      // 遲入/重進/盲信使靠同一套補齊），故消費與轉發並存、僅「不顯示」。
      if (message.channel === 'keyx') {
        await this.contentKeys.consumeKeyx(message);
      } else {
        // 顯示訊息。注意：顯示不受 ttl 限制——ttl 只限制主動洪泛半徑，
        // 訊息既已到達（含 anti-entropy 補送），對使用者就必須恰好一次呈現。
        // 密文化（P2-②）：僅「顯示副本」解密；store/轉發/對帳沿用密文原封（盲信使相容）。
        this.notifyMessageListeners(await this.contentKeys.toDisplayMessage(message));
      }

      // 轉發（建立副本以避免修改傳入物件）；ttl 耗盡則不轉發，缺口由對帳補
      if (message.ttl > 0) {
        const forwarded: GossipMessage = { ...message, ttl: message.ttl - 1 };
        await this.forwardMessage(forwarded, fromNeighbor);
      }
    } finally {
      this.inflight.delete(key);
    }
  }

  /** 是否已持有 (senderId, sessionEpoch, seq) */
  private hasMessage(senderId: string, sessionEpoch: number, seq: number): boolean {
    return this.store.get(senderId)?.get(sessionEpoch)?.has(seq) ?? false;
  }

  /**
   * 採納某 sender 的新現行代（Spec 009 §4.5）：推進 acceptedEpoch（持久 best-effort）、
   * 剪除記憶體中該 sender 的舊代桶與 floors（inert 歷史：不再宣告、不再補送；
   * 持久層保留，聊天顯示歷史本就存應用層 chatStorage，不受影響）。
   */
  private adoptEpoch(senderId: string, epoch: number): void {
    this.acceptedEpochs.set(senderId, epoch);
    const epochs = this.store.get(senderId);
    if (epochs) {
      for (const ep of [...epochs.keys()]) {
        if (ep < epoch) epochs.delete(ep);
      }
    }
    const byEpoch = this.floors.get(senderId);
    if (byEpoch) {
      for (const ep of [...byEpoch.keys()]) {
        if (ep < epoch) byEpoch.delete(ep);
      }
    }
    if (this.persistence) {
      void this.persistence.saveAcceptedEpoch(this.roomId, senderId, epoch).catch((err) => {
        logger.warn('[GossipMessageHandler] saveAcceptedEpoch failed', {
          roomId: this.roomId, err,
        });
      });
    }
    logger.info('[GossipMessageHandler] session epoch adopted', {
      roomId: this.roomId, senderId, epoch,
    });
  }

  /**
   * 寫入分代 store；該代桶超過每 sender 上限時淘汰最舊 seq 並推進該代 floor。
   * @param persist 寫入持久複本（hydrate 回灌時傳 false 避免無謂回寫）。
   *   持久寫入為非阻塞 best-effort：最壞情況重載後缺一筆「已顯示」紀錄，
   *   由任一持有的成員經對帳補回（複本互補正是本架構的保證）。
   */
  private storePut(message: GossipMessage, persist = true): void {
    const epoch = this.epochOf(message);
    let epochs = this.store.get(message.senderId);
    if (!epochs) {
      epochs = new Map();
      this.store.set(message.senderId, epochs);
    }
    let seqs = epochs.get(epoch);
    if (!seqs) {
      seqs = new Map();
      epochs.set(epoch, seqs);
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
      let byEpoch = this.floors.get(message.senderId);
      if (!byEpoch) this.floors.set(message.senderId, (byEpoch = new Map()));
      const floor = byEpoch.get(epoch) ?? 1;
      const newFloor = Math.max(floor, oldest + 1);
      byEpoch.set(epoch, newFloor);
      if (this.persistence) {
        void this.persistence
          .evictRecord(this.roomId, message.senderId, epoch, oldest, newFloor)
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
    // 只宣告各 sender 已驗證現行代的持有（Spec 009 §4.6）；僅持 legacy 0 代者不宣告
    const digest = computeDigest(this.store, this.floors, this.acceptedEpochs);
    if (Object.keys(digest).length === 0) return;
    try {
      await neighbor.sendDigest(digest);
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
    const digest: NormalizedDigest | null = normalizeDigest(rawDigest);
    if (!digest) {
      logger.warn('[GossipMessageHandler] Malformed digest ignored', {
        roomId: this.roomId,
        neighborId: neighbor.getId(),
      });
      return;
    }

    // 只從各 sender 的現行代桶補送（Spec 009 §4.6）：舊代/legacy 送了必被拒，不送
    const fills: GossipMessage[] = [];
    outer: for (const [senderId, epoch] of this.acceptedEpochs) {
      const seqs = this.store.get(senderId)?.get(epoch);
      if (!seqs) continue;
      for (const [seq, msg] of seqs) {
        if (peerLacks(digest, senderId, epoch, seq)) {
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
  private checkSendRate(senderId: string, channel: NonNullable<GossipMessage['channel']>): boolean {
    const now = Date.now();
    // 控制面 keyx/read/reaction 與使用者 chat 分桶；否則進房時的金鑰交換／已讀水位
    // 會偷吃 10 msg/s 的聊天額度，使合法的 10 則 burst 在第 5–9 則被拒。
    const bucket = `${senderId}:${channel}`;
    const timestamps = this.sendRateLimiter.get(bucket) || [];
    const recent = timestamps.filter(ts => now - ts < 1000);

    if (recent.length >= this.MAX_MESSAGES_PER_SECOND) {
      return false; // 超過速率限制
    }

    recent.push(now);
    this.sendRateLimiter.set(bucket, recent);
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
