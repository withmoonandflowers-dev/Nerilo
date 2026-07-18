import { arrayBufferToBase64, base64ToArrayBuffer } from '../../utils/crypto';
import type { GossipMessage } from '../../types';
import { logger } from '../../utils/logger';

/**
 * 安全管理器
 * 負責訊息的簽名和驗證
 */
export class SecurityManager {
  /** 訊息最大有效時間（5 分鐘）——verifyMessage 的預設時效窗，可由呼叫端停用 */
  private static readonly MAX_MESSAGE_AGE_MS = 5 * 60 * 1000;
  /** 容忍的時鐘偏差：timestamp 超前本地時鐘逾此值一律拒絕（不受 maxAgeMs 影響） */
  private static readonly MAX_CLOCK_SKEW_MS = 30_000;

  /**
   * 簽名訊息
   */
  async signMessage(
    message: Omit<GossipMessage, 'signature'>,
    privateKey: CryptoKey
  ): Promise<string> {
    // 將訊息序列化。ttl 是「會在轉發時遞減」的可變路由欄位，必須排除在
    // 簽章之外（同 IPsec 對 mutable field 的處理）——把 ttl 簽進去會讓
    // 所有經轉發（ttl-1）的副本簽章必然失效，gossip 轉發路徑整條壞死。
    // ttl 被竄改只影響洪泛半徑，不影響訊息完整性（內容欄位全數有簽）。
    // messageId 是跨傳輸路徑去重的依據，必須簽（否則可竄改造成收端重複顯示）。
    // channel 決定上層分發（chat/game），必須簽（否則可跨通道錯誤分發）。
    // sessionEpoch 是跨會話重放防護的根基（Spec 009），必須簽（否則舊會話
    // 訊息可改標新代重放）。序列化順序凍結於 Spec 009 §4.4，v1↔v2 不互通
    // 屬預期（版本訊號見 GOSSIP_HELLO）。
    const messageData = JSON.stringify({
      roomId: message.roomId,
      senderId: message.senderId,
      pubKey: message.pubKey,
      seq: message.seq,
      sessionEpoch: message.sessionEpoch,
      timestamp: message.timestamp,
      content: message.content,
      ...(message.messageId !== undefined ? { messageId: message.messageId } : {}),
      ...(message.channel !== undefined ? { channel: message.channel } : {}),
    });

    // 計算 hash
    const encoder = new TextEncoder();
    const messageHash = await crypto.subtle.digest(
      'SHA-256',
      encoder.encode(messageData)
    );
    
    // 使用私鑰簽名
    const signature = await crypto.subtle.sign(
      {
        name: 'ECDSA',
        hash: 'SHA-256',
      },
      privateKey,
      messageHash
    );
    
    // 轉換為 Base64
    return arrayBufferToBase64(signature);
  }

  /**
   * 驗證訊息簽名
   *
   * @param options.maxAgeMs 時效窗（ms）；未給用預設 5 分鐘，傳 null 停用過期檢查。
   *   gossip 收訊路徑必須傳 null：anti-entropy 補送的是原始已簽名訊息，線路上與
   *   首次洪泛無法區分，任何 wall-clock 門檻都會把補給遲到者的舊訊息拒掉、破壞
   *   「最終各恰好一次」。該路徑的重放防護由 (senderId, seq) store 去重承擔
   *   （見 GossipMessageHandler.handleReceivedMessage）。未來時間戳不受此參數
   *   影響、一律拒絕——合法補送只會帶過去的 timestamp。
   */
  async verifyMessage(
    message: GossipMessage,
    publicKey: CryptoKey,
    options?: { maxAgeMs?: number | null }
  ): Promise<boolean> {
    try {
      // 防止 replay attack：拒絕過期或未來訊息（時效窗可依呼叫端停用，見上）
      const maxAgeMs =
        options?.maxAgeMs === undefined
          ? SecurityManager.MAX_MESSAGE_AGE_MS
          : options.maxAgeMs;
      const age = Date.now() - message.timestamp;
      if (
        (maxAgeMs !== null && age > maxAgeMs) ||
        age < -SecurityManager.MAX_CLOCK_SKEW_MS
      ) {
        logger.warn('[SecurityManager] Message rejected: stale or future timestamp', {
          senderId: message.senderId,
          ageMs: age,
        });
        return false;
      }

      const signature = base64ToArrayBuffer(message.signature);
      
      // 重新計算訊息 hash（不含 ttl、含 sessionEpoch，與 signMessage 對稱；理由見該處註解）
      const messageData = JSON.stringify({
        roomId: message.roomId,
        senderId: message.senderId,
        pubKey: message.pubKey,
        seq: message.seq,
        sessionEpoch: message.sessionEpoch,
        timestamp: message.timestamp,
        content: message.content,
        ...(message.messageId !== undefined ? { messageId: message.messageId } : {}),
        ...(message.channel !== undefined ? { channel: message.channel } : {}),
      });
      
      const encoder = new TextEncoder();
      const messageHash = await crypto.subtle.digest(
        'SHA-256',
        encoder.encode(messageData)
      );
      
      // 驗證簽名
      return await crypto.subtle.verify(
        {
          name: 'ECDSA',
          hash: 'SHA-256',
        },
        publicKey,
        signature,
        messageHash
      );
    } catch (error) {
      logger.error('[SecurityManager] Error verifying message', { error });
      return false;
    }
  }

  /**
   * 匯入公鑰
   */
  async importPublicKey(pubKeyBase64: string): Promise<CryptoKey> {
    const keyData = base64ToArrayBuffer(pubKeyBase64);
    return await crypto.subtle.importKey(
      'spki',
      keyData,
      {
        name: 'ECDSA',
        namedCurve: 'P-256',
      },
      // 必須可匯出：收訊時 IdentityManager.deriveUserId 會對此 key 做
      // exportKey('spki') 以驗證 pubKey↔senderId 一致。設 false 會讓 exportKey
      // 擲錯，導致每則 gossip 訊息在身分驗證處炸掉、永不送達（mesh 訊息不互通）。
      // 公鑰本為公開資訊，可匯出無安全風險。
      true,
      ['verify']
    );
  }
}
