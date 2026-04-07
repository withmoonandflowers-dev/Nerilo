import { arrayBufferToBase64, base64ToArrayBuffer } from '../../utils/crypto';
import type { GossipMessage } from '../../types';

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
    // 將訊息（除 signature 外）序列化
    const messageData = JSON.stringify({
      roomId: message.roomId,
      senderId: message.senderId,
      pubKey: message.pubKey,
      seq: message.seq,
      timestamp: message.timestamp,
      content: message.content,
      ttl: message.ttl,
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
        console.warn('[SecurityManager] Message rejected: stale or future timestamp', {
          senderId: message.senderId,
          ageMs: age,
        });
        return false;
      }

      const signature = base64ToArrayBuffer(message.signature);
      
      // 重新計算訊息 hash
      const messageData = JSON.stringify({
        roomId: message.roomId,
        senderId: message.senderId,
        pubKey: message.pubKey,
        seq: message.seq,
        timestamp: message.timestamp,
        content: message.content,
        ttl: message.ttl,
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
      console.error('[SecurityManager] Error verifying message', { error });
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
      false, // 不可匯出
      ['verify']
    );
  }
}
