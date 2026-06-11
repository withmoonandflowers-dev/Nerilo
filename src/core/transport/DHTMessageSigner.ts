/**
 * DHTMessageSigner — DHT 協議訊息的 ECDSA 簽名與驗證
 *
 * DHT（分散式雜湊表）用來做離線訊息投遞：
 *   DHT_STORE / DHT_RETRIEVE / DHT_RESPONSE / DHT_DELETE
 *
 * 原本這些協議訊息是無簽名的 → 任何人都能偽造 DHT_STORE 灌入假訊息，
 * 或偽造 DHT_DELETE 刪掉別人的訊息。
 *
 * 這個模組為 DHT 協議訊息加上：
 *   1. 發送者的 ECDSA 簽名（證明訊息來自聲稱的 fromId）
 *   2. 接收端的簽名驗證（拒絕偽造的 DHT 操作）
 *   3. 公鑰快取（避免每次都重新 import）
 *
 * 整合方式：
 *   - 發送前：呼叫 signMessage() 產生簽名欄位
 *   - 接收後：呼叫 verifyMessage() 驗證簽名
 *   - 搭配 DHTStorage / DHTStoreAndForward 使用
 */

/** 已簽名的 DHT 訊息（在原有結構上加 signature + senderPubKey） */
export interface SignedDHTFields {
  /** ECDSA 簽名（Base64） */
  signature: string;
  /** 發送者的 Base64 SPKI 公鑰 */
  senderPubKey: string;
  /** 簽名時間戳（防 replay） */
  signedAt: number;
}

/** DHT 訊息簽名用的規範化資料 */
export interface DHTSignableData {
  type: string;
  fromId: string;
  recipientId: string;
  roomId: string;
  requestId: string;
  /** 額外欄位（messageId 陣列或 payload 雜湊） */
  contentHash?: string;
}

/** 簽名驗證結果 */
export interface DHTVerifyResult {
  valid: boolean;
  reason?: 'missing-signature' | 'expired' | 'invalid-signature' | 'pubkey-mismatch' | 'import-error';
}

export interface DHTSignerConfig {
  /** 簽名有效期限（毫秒，預設 10 分鐘） */
  signatureExpiryMs: number;
  /** 公鑰快取大小（預設 200） */
  pubKeyCacheSize: number;
}

const DEFAULT_CONFIG: DHTSignerConfig = {
  signatureExpiryMs: 10 * 60 * 1000,
  pubKeyCacheSize: 200,
};

export class DHTMessageSigner {
  private config: DHTSignerConfig;
  /** 已匯入的公鑰快取：userId → CryptoKey */
  private pubKeyCache = new Map<string, CryptoKey>();
  /** 本機私鑰 */
  private privateKey: CryptoKey | null = null;
  /** 本機公鑰（Base64 SPKI） */
  private localPubKey: string = '';
  constructor(config?: Partial<DHTSignerConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * 初始化：設定本機的簽名金鑰。
   * 在 DHTStoreAndForward 初始化時呼叫。
   */
  init(_localId: string, privateKey: CryptoKey, pubKeyBase64: string): void {
    this.privateKey = privateKey;
    this.localPubKey = pubKeyBase64;
  }

  /**
   * 為 DHT 訊息產生簽名欄位。
   *
   * @param data 要簽名的規範化資料
   * @returns 簽名欄位（附加到 DHT 訊息上）
   */
  async signMessage(data: DHTSignableData): Promise<SignedDHTFields> {
    if (!this.privateKey) {
      throw new Error('[DHTMessageSigner] 未初始化：缺少 privateKey');
    }

    const signedAt = Date.now();
    const payload = this.canonicalize(data, signedAt);
    const encoded = new TextEncoder().encode(payload);

    // SHA-256 → ECDSA 簽名
    const hash = await crypto.subtle.digest('SHA-256', encoded);
    const signatureBuffer = await crypto.subtle.sign(
      { name: 'ECDSA', hash: 'SHA-256' },
      this.privateKey,
      hash,
    );

    return {
      signature: this.arrayBufferToBase64(signatureBuffer),
      senderPubKey: this.localPubKey,
      signedAt,
    };
  }

  /**
   * 驗證 DHT 訊息的簽名。
   *
   * @param data      規範化資料（與簽名時相同的欄位）
   * @param signed    簽名欄位
   * @param expectedFromId  預期的發送者 userId（用來比對公鑰推導）
   */
  async verifyMessage(
    data: DHTSignableData,
    signed: SignedDHTFields,
    expectedFromId?: string,
  ): Promise<DHTVerifyResult> {
    // 檢查簽名欄位是否存在
    if (!signed.signature || !signed.senderPubKey) {
      return { valid: false, reason: 'missing-signature' };
    }

    // 檢查時間戳
    const age = Date.now() - signed.signedAt;
    if (age > this.config.signatureExpiryMs || age < -30_000) {
      return { valid: false, reason: 'expired' };
    }

    // 匯入或從快取取得公鑰
    let pubKey: CryptoKey;
    try {
      pubKey = await this.importOrGetCachedKey(signed.senderPubKey);
    } catch {
      return { valid: false, reason: 'import-error' };
    }

    // 如果有指定 expectedFromId，推導公鑰的 userId 來比對
    if (expectedFromId) {
      const derivedId = await this.deriveUserId(pubKey);
      if (derivedId !== expectedFromId) {
        return { valid: false, reason: 'pubkey-mismatch' };
      }
    }

    // 重建簽名原文
    const payload = this.canonicalize(data, signed.signedAt);
    const encoded = new TextEncoder().encode(payload);
    const hash = await crypto.subtle.digest('SHA-256', encoded);

    // 驗證 ECDSA 簽名
    try {
      const signatureBuffer = this.base64ToArrayBuffer(signed.signature);
      const valid = await crypto.subtle.verify(
        { name: 'ECDSA', hash: 'SHA-256' },
        pubKey,
        signatureBuffer,
        hash,
      );

      if (!valid) {
        return { valid: false, reason: 'invalid-signature' };
      }
      return { valid: true };
    } catch {
      return { valid: false, reason: 'invalid-signature' };
    }
  }

  /** 清空公鑰快取 */
  clearCache(): void {
    this.pubKeyCache.clear();
  }

  /** 銷毀 */
  destroy(): void {
    this.pubKeyCache.clear();
    this.privateKey = null;
    this.localPubKey = '';
  }

  // ── 內部方法 ─────────────────────────────────────────────────────────

  /**
   * 規範化訊息內容為確定性字串（簽名 / 驗證用）。
   */
  private canonicalize(data: DHTSignableData, signedAt: number): string {
    return JSON.stringify({
      type: data.type,
      fromId: data.fromId,
      recipientId: data.recipientId,
      roomId: data.roomId,
      requestId: data.requestId,
      contentHash: data.contentHash ?? '',
      signedAt,
    });
  }

  /**
   * 從快取取得或匯入公鑰。
   */
  private async importOrGetCachedKey(pubKeyBase64: string): Promise<CryptoKey> {
    const cached = this.pubKeyCache.get(pubKeyBase64);
    if (cached) return cached;

    const keyData = this.base64ToArrayBuffer(pubKeyBase64);
    const key = await crypto.subtle.importKey(
      'spki',
      keyData,
      { name: 'ECDSA', namedCurve: 'P-256' },
      true, // 需要 extractable 以推導 userId
      ['verify'],
    );

    // LRU 淘汰
    if (this.pubKeyCache.size >= this.config.pubKeyCacheSize) {
      const oldest = this.pubKeyCache.keys().next().value;
      if (oldest !== undefined) this.pubKeyCache.delete(oldest);
    }

    this.pubKeyCache.set(pubKeyBase64, key);
    return key;
  }

  /**
   * 從公鑰推導 userId（與 IdentityManager.deriveUserId 相同邏輯）。
   */
  private async deriveUserId(publicKey: CryptoKey): Promise<string> {
    const exported = await crypto.subtle.exportKey('spki', publicKey);
    const base64 = this.arrayBufferToBase64(exported);
    const encoded = new TextEncoder().encode(base64);
    const hash = await crypto.subtle.digest('SHA-256', encoded);
    const hashArray = new Uint8Array(hash);
    const hex = [...hashArray].map(b => b.toString(16).padStart(2, '0')).join('');
    return hex.substring(0, 32);
  }

  private arrayBufferToBase64(buffer: ArrayBuffer): string {
    const bytes = new Uint8Array(buffer);
    let binary = '';
    for (const b of bytes) binary += String.fromCharCode(b);
    return btoa(binary);
  }

  private base64ToArrayBuffer(base64: string): ArrayBuffer {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes.buffer as ArrayBuffer;
  }
}
