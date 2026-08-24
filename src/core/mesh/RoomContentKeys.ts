import {
  encryptRecordContent,
  decryptRecordContent,
  isEncryptedContent,
  contentEpoch,
} from './RecordCrypto';
import { openSealedRoomKey } from './RoomKeyDistribution';
import { base64ToArrayBuffer } from '../../utils/crypto';
import type { GossipMessage, KeyxRecordPayload } from '../../types';
import { logger } from '../../utils/logger';

/**
 * 房間內容金鑰環（ADR-0023 P2-②；自 GossipMessageHandler 抽出的內聚關注點）。
 *
 * epoch → 房間內容金鑰。此處的 epoch 是「房間金鑰代」（keyx 輪替），與 Spec 009
 * 的 sessionEpoch（會話代）、SenderKeyManager 的 senderKeyEpoch 是三個不同的代。
 *
 * 空環 = 尚未就緒 → 收送退明文相容。保留多個 epoch：加人/移除輪替後，仍能解
 * 舊 epoch 的歷史密文（前向保密下的相容補歷史）。
 */
/** 每會話最多主動請求換代次數（Spec 022 C2 防失控上限；用盡＝需要人介入）。 */
const MAX_REDISTRIBUTION_REQUESTS = 3;

export class RoomContentKeyRing {
  /**
   * 金鑰環（Spec 022）：連同「這一代的鑰是誰發的」一起記。producer 取自已簽章且經
   * deriveUserId(pubKey)===senderId 綁定驗證的 GossipMessage.senderId——已被密碼學
   * 綁定的身分，零新增信任假設。
   * 已知殘留（4.1 拍板）：不比對金鑰材料本身，故「同一產生方同代發不同鑰」偵測不到；
   * 該情況已由協調器 distributedRosterSig 冪等守衛擋住，此處以產生方身分為準。
   */
  private keyRing: Map<number, { key: CryptoKey; producer: string }> = new Map();
  /** 同代異鑰衝突記錄（epoch → 兩位產生方）；也是「每 epoch 只吼/只請求一次」的去重集合。 */
  private conflicts: Map<number, { first: string; rejected: string }> = new Map();
  private redistributionRequests = 0;
  private onKeyConflict: ((epoch: number) => void) | null = null;
  /** 目前送出用的 epoch（金鑰環中最高者）；送出一律用最新金鑰。null = 無金鑰。 */
  private sendEpoch: number | null = null;
  /** 本機 ECDH 私鑰（開出封給自己的 keyx）。null = 不參與密文化（無鑰退明文）。 */
  private ecdhPrivateKey: CryptoKey | null = null;
  /**
   * 金鑰安裝回呼（Spec 009×012 合流修復）：晚到的金鑰安裝後，呼叫端據此把先前
   * 以佔位呈現的該 epoch 密文「補顯示」（重派解密內容，UI 以同 id upsert）。
   */
  private onKeyInstalled: ((epoch: number) => void) | null = null;

  constructor(private roomId: string, private userId: string) {}

  /** 設定金鑰安裝回呼（epoch＝房間金鑰代）。 */
  setOnKeyInstalled(cb: ((epoch: number) => void) | null): void {
    this.onKeyInstalled = cb;
  }

  /** 偵測到同代異鑰時的回呼（上層據此請求換代；受每會話上限保護）。 */
  setOnKeyConflict(cb: ((epoch: number) => void) | null): void {
    this.onKeyConflict = cb;
  }

  /** 衝突狀態查詢（Spec 022 C3）：發生過衝突的 epoch 與是否已達換代請求上限。 */
  getKeyConflicts(): { epochs: number[]; requestLimitReached: boolean } {
    return {
      epochs: [...this.conflicts.keys()].sort((a, b) => a - b),
      requestLimitReached: this.redistributionRequests >= MAX_REDISTRIBUTION_REQUESTS,
    };
  }

  /**
   * 加入/設定一把房間內容金鑰到金鑰環。key=null 清空整個環（退明文，含衝突記錄）。
   * epoch 較高者成為送出用金鑰；解密則按各密文信封的 epoch 選環中對應金鑰。
   *
   * 同代語義（Spec 022）：無鑰＝安裝；同產生方＝冪等 no-op（hydrate 重放安全）；
   * **不同產生方＝拒絕後到者**——先到的金鑰不動、記錄衝突、每 epoch 一次告警與換代請求。
   * 靜默覆寫是本 spec 的病灶：覆寫會讓先到方的密文永久解不開且無跡可循。
   */
  setContentKey(key: CryptoKey | null, epoch = 0, producer?: string): void {
    if (key === null) {
      this.keyRing.clear();
      this.sendEpoch = null;
      this.conflicts.clear();
      this.redistributionRequests = 0;
      return;
    }
    const from = producer ?? this.userId; // 未標示＝本機（產生方自裝路徑）
    const existing = this.keyRing.get(epoch);
    if (existing) {
      if (existing.producer === from) return; // 同代同產生方：冪等
      if (!this.conflicts.has(epoch)) {
        this.conflicts.set(epoch, { first: existing.producer, rejected: from });
        logger.warn('[RoomContentKeyRing] key conflict — same epoch, different producer; keeping first', {
          roomId: this.roomId, epoch, firstProducer: existing.producer, rejectedProducer: from,
          redistributionRequested: this.redistributionRequests < MAX_REDISTRIBUTION_REQUESTS,
        });
        if (this.redistributionRequests < MAX_REDISTRIBUTION_REQUESTS && this.onKeyConflict) {
          this.redistributionRequests++;
          try { this.onKeyConflict(epoch); } catch (err) {
            logger.error('[RoomContentKeyRing] onKeyConflict callback error', { roomId: this.roomId, epoch, err });
          }
        }
      }
      return; // 先到勝出（C2），後到的被拒絕
    }
    this.keyRing.set(epoch, { key, producer: from });
    if (this.sendEpoch === null || epoch >= this.sendEpoch) {
      this.sendEpoch = epoch;
    }
    if (this.onKeyInstalled) {
      try {
        this.onKeyInstalled(epoch);
      } catch (err) {
        logger.error('[RoomContentKeyRing] onKeyInstalled callback error', {
          roomId: this.roomId, epoch, err,
        });
      }
    }
  }

  /** 注入本機 ECDH 私鑰，啟用 keyx 消費（開出封給自己的房間金鑰）。 */
  setKeyxPrivateKey(ecdhPrivateKey: CryptoKey | null): void {
    this.ecdhPrivateKey = ecdhPrivateKey;
  }

  /** 送出時是否會加密（sendEpoch 已就緒）。false = 目前送出走明文（ADR-0026 R2）。 */
  hasSendKey(): boolean {
    return this.sendEpoch !== null;
  }

  /**
   * 目前送出金鑰與其 epoch（Spec 023 raw 通道用；唯讀）。無金鑰回 null。
   * raw 通道不走字串信封（每 byte 都是延遲），需要裸 CryptoKey 做二進位密封。
   */
  getSendKeyWithEpoch(): { key: CryptoKey; epoch: number } | null {
    if (this.sendEpoch === null) return null;
    const entry = this.keyRing.get(this.sendEpoch);
    return entry ? { key: entry.key, epoch: this.sendEpoch } : null;
  }

  /** 指定 epoch 的金鑰（Spec 023 raw 通道收端選鑰；唯讀）。無則 undefined。 */
  getKeyForEpoch(epoch: number): CryptoKey | undefined {
    return this.keyRing.get(epoch)?.key;
  }

  /** 金鑰環中已知最高 epoch（-1 = 尚無金鑰）；供產生方交接時 epoch 單調遞增。 */
  getMaxKnownEpoch(): number {
    let max = -1;
    for (const ep of this.keyRing.keys()) if (ep > max) max = ep;
    return max;
  }

  /**
   * 以目前送出金鑰加密明文（線上/備援共用）。無金鑰回 null——呼叫端據此「不送」
   * 或走明文相容，不得默默退明文洩漏。
   */
  async encryptOutgoing(plaintext: string): Promise<string | null> {
    const entry = this.sendEpoch !== null ? this.keyRing.get(this.sendEpoch) : undefined;
    if (!entry || this.sendEpoch === null) return null;
    return encryptRecordContent(plaintext, entry.key, this.sendEpoch);
  }

  /**
   * 解 RecordCrypto 信封字串 → 明文，按信封 epoch 選環中金鑰。
   * 無對應 epoch 金鑰（未在籍/未補齊）→ 拋錯，呼叫端顯示佔位。
   */
  async decryptEnvelope(envelope: string): Promise<string> {
    const ep = contentEpoch(envelope);
    const entry = ep !== null ? this.keyRing.get(ep) : undefined;
    if (!entry) throw new Error('no room key for decrypt');
    return decryptRecordContent(envelope, entry.key);
  }

  /**
   * 產生「顯示用副本」：content 是密文且持有對應金鑰 → 解密副本；明文 → 原封；
   * 密文但無金鑰（尚未補齊 keyx）→ 佔位字串誠實呈現。
   * 不修改傳入物件——store/轉發/對帳要的是密文原封。
   */
  async toDisplayMessage(message: GossipMessage): Promise<GossipMessage> {
    if (!isEncryptedContent(message.content)) return message; // 明文相容路徑
    const ep = contentEpoch(message.content);
    const entry = ep !== null ? this.keyRing.get(ep) : undefined;
    if (!entry) {
      return { ...message, content: '[🔒 訊息已加密，尚未取得金鑰]' };
    }
    try {
      const plain = await decryptRecordContent(message.content, entry.key);
      return { ...message, content: plain };
    } catch (err) {
      logger.warn('[RoomContentKeyRing] decrypt for display failed', {
        roomId: this.roomId, senderId: message.senderId, seq: message.seq, err,
      });
      return { ...message, content: '[🔒 無法解密此訊息]' };
    }
  }

  /**
   * 消費 keyx 紀錄（ADR-0023 P2-②c）：找出封給自己（forMember == 本機 userId）的那份，
   * 以本機 ECDH 私鑰 + 紀錄內嵌的 producerEcdh 開出房間金鑰 → 加入金鑰環（該 epoch）。
   *
   * 呼叫端保證已通過簽章驗證（producerEcdh 隨簽章一併驗真）。
   * 無 ECDH 私鑰、非封給自己、或開鑰失敗 → 靜默略過（無鑰退明文相容）。
   */
  async consumeKeyx(message: GossipMessage): Promise<void> {
    if (!this.ecdhPrivateKey) return; // 不參與密文化
    let payload: KeyxRecordPayload;
    try {
      payload = JSON.parse(message.content) as KeyxRecordPayload;
    } catch {
      return; // 畸形 keyx，忽略
    }
    if (payload?.v !== 'keyx1' || typeof payload.producerEcdh !== 'string' || !Array.isArray(payload.keys)) {
      return;
    }
    const mine = payload.keys.find((k) => k?.forMember === this.userId);
    if (!mine) return; // 沒有封給我的份（例如我加入前的舊 epoch keyx）

    try {
      const producerEcdh = await crypto.subtle.importKey(
        'spki',
        base64ToArrayBuffer(payload.producerEcdh),
        { name: 'ECDH', namedCurve: 'P-256' },
        true,
        []
      );
      const roomKey = await openSealedRoomKey(
        { forMember: mine.forMember, epoch: mine.epoch, enc: mine.enc, iv: mine.iv },
        this.ecdhPrivateKey,
        producerEcdh
      );
      this.setContentKey(roomKey, mine.epoch, message.senderId);
      logger.info('[RoomContentKeyRing] keyx consumed — room key installed', {
        roomId: this.roomId, epoch: mine.epoch, from: message.senderId,
      });
    } catch (err) {
      logger.warn('[RoomContentKeyRing] keyx open failed', {
        roomId: this.roomId, epoch: mine.epoch, err,
      });
    }
  }
}
