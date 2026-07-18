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
export class RoomContentKeyRing {
  private keyRing: Map<number, CryptoKey> = new Map();
  /** 目前送出用的 epoch（金鑰環中最高者）；送出一律用最新金鑰。null = 無金鑰。 */
  private sendEpoch: number | null = null;
  /** 本機 ECDH 私鑰（開出封給自己的 keyx）。null = 不參與密文化（無鑰退明文）。 */
  private ecdhPrivateKey: CryptoKey | null = null;

  constructor(private roomId: string, private userId: string) {}

  /**
   * 加入/設定一把房間內容金鑰到金鑰環。key=null 清空整個環（退明文）。
   * epoch 較高者成為送出用金鑰；解密則按各密文信封的 epoch 選環中對應金鑰。
   */
  setContentKey(key: CryptoKey | null, epoch = 0): void {
    if (key === null) {
      this.keyRing.clear();
      this.sendEpoch = null;
      return;
    }
    this.keyRing.set(epoch, key);
    if (this.sendEpoch === null || epoch >= this.sendEpoch) {
      this.sendEpoch = epoch;
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
    const key = this.sendEpoch !== null ? this.keyRing.get(this.sendEpoch) : undefined;
    if (!key || this.sendEpoch === null) return null;
    return encryptRecordContent(plaintext, key, this.sendEpoch);
  }

  /**
   * 解 RecordCrypto 信封字串 → 明文，按信封 epoch 選環中金鑰。
   * 無對應 epoch 金鑰（未在籍/未補齊）→ 拋錯，呼叫端顯示佔位。
   */
  async decryptEnvelope(envelope: string): Promise<string> {
    const ep = contentEpoch(envelope);
    const key = ep !== null ? this.keyRing.get(ep) : undefined;
    if (!key) throw new Error('no room key for decrypt');
    return decryptRecordContent(envelope, key);
  }

  /**
   * 產生「顯示用副本」：content 是密文且持有對應金鑰 → 解密副本；明文 → 原封；
   * 密文但無金鑰（尚未補齊 keyx）→ 佔位字串誠實呈現。
   * 不修改傳入物件——store/轉發/對帳要的是密文原封。
   */
  async toDisplayMessage(message: GossipMessage): Promise<GossipMessage> {
    if (!isEncryptedContent(message.content)) return message; // 明文相容路徑
    const ep = contentEpoch(message.content);
    const key = ep !== null ? this.keyRing.get(ep) : undefined;
    if (!key) {
      return { ...message, content: '[🔒 訊息已加密，尚未取得金鑰]' };
    }
    try {
      const plain = await decryptRecordContent(message.content, key);
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
      this.setContentKey(roomKey, mine.epoch);
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
