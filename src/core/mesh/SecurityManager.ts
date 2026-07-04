import { arrayBufferToBase64, base64ToArrayBuffer } from '../../utils/crypto';
import type { GossipMessage } from '../../types';
import { logger } from '../../utils/logger';

/**
 * 安全管理器
 * 負責訊息的簽名和驗證
 */
export class SecurityManager {
  /** 訊息最大有效時間（5 分鐘） */
  private static readonly MAX_MESSAGE_AGE_MS = 5 * 60 * 1000;

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
    const messageData = JSON.stringify({
      roomId: message.roomId,
      senderId: message.senderId,
      pubKey: message.pubKey,
      seq: message.seq,
      timestamp: message.timestamp,
      content: message.content,
      ...(message.messageId !== undefined ? { messageId: message.messageId } : {}),
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
   */
  async verifyMessage(
    message: GossipMessage,
    publicKey: CryptoKey
  ): Promise<boolean> {
    try {
      // 防止 replay attack：拒絕過期訊息
      const age = Date.now() - message.timestamp;
      if (age > SecurityManager.MAX_MESSAGE_AGE_MS || age < -30_000) {
        logger.warn('[SecurityManager] Message rejected: stale or future timestamp', {
          senderId: message.senderId,
          ageMs: age,
        });
        return false;
      }

      const signature = base64ToArrayBuffer(message.signature);
      
      // 重新計算訊息 hash（不含 ttl，與 signMessage 對稱；理由見該處註解）
      const messageData = JSON.stringify({
        roomId: message.roomId,
        senderId: message.senderId,
        pubKey: message.pubKey,
        seq: message.seq,
        timestamp: message.timestamp,
        content: message.content,
        ...(message.messageId !== undefined ? { messageId: message.messageId } : {}),
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
