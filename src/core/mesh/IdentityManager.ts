import { arrayBufferToBase64, sha256Hash, base64ToArrayBuffer } from '../../utils/crypto';

/**
 * 身分管理器
 * 負責生成和管理密鑰對，以及計算使用者 ID
 */
export class IdentityManager {
  private keyPair: CryptoKeyPair | null = null;
  private userId: string | null = null;
  private readonly STORAGE_KEY = 'mesh_keypair';

  /**
   * 初始化（生成或載入密鑰對）
   */
  async initialize(): Promise<void> {
    // 嘗試從 IndexedDB 載入
    const savedKeyPair = await this.loadKeyPairFromStorage();
    
    if (savedKeyPair) {
      this.keyPair = savedKeyPair;
      // 計算 userId
      this.userId = await this.deriveUserId(this.keyPair.publicKey);
      console.log('[IdentityManager] Loaded key pair from storage', {
        userId: this.userId,
      });
    } else {
      // 生成新密鑰對
      this.keyPair = await this.generateKeyPair();
      this.userId = await this.deriveUserId(this.keyPair.publicKey);
      
      // 儲存到 IndexedDB
      await this.saveKeyPairToStorage(this.keyPair);
      console.log('[IdentityManager] Generated new key pair', {
        userId: this.userId,
      });
    }
  }

  /**
   * 生成 ECDSA 密鑰對
   */
  private async generateKeyPair(): Promise<CryptoKeyPair> {
    return await crypto.subtle.generateKey(
      {
        name: 'ECDSA',
        namedCurve: 'P-256',
      },
      true, // 可匯出
      ['sign', 'verify']
    );
  }

  /**
   * 從公鑰計算 userId
   */
  async deriveUserId(publicKey: CryptoKey): Promise<string> {
    const exportedKey = await crypto.subtle.exportKey('spki', publicKey);
    const hash = await sha256Hash(arrayBufferToBase64(exportedKey));
    
    // 使用前 32 字元作為 userId（16 bytes = 32 hex chars）
    return hash.substring(0, 32);
  }

  /**
   * 匯出公鑰（Base64）
   */
  async exportPublicKey(): Promise<string> {
    if (!this.keyPair) {
      throw new Error('Key pair not initialized. Call initialize() first.');
    }
    const exported = await crypto.subtle.exportKey('spki', this.keyPair.publicKey);
    return arrayBufferToBase64(exported);
  }

  /**
   * 獲取使用者 ID
   */
  getUserId(): string {
    if (!this.userId) {
      throw new Error('User ID not initialized. Call initialize() first.');
    }
    return this.userId;
  }

  /**
   * 獲取私鑰
   */
  getPrivateKey(): CryptoKey {
    if (!this.keyPair) {
      throw new Error('Key pair not initialized. Call initialize() first.');
    }
    return this.keyPair.privateKey;
  }

  /**
   * 從 IndexedDB 載入密鑰對
   */
  private async loadKeyPairFromStorage(): Promise<CryptoKeyPair | null> {
    try {
      // 嘗試從 localStorage 載入（簡化版，實際應該使用 IndexedDB）
      const savedPubKey = localStorage.getItem(`${this.STORAGE_KEY}_public`);
      const savedPrivKey = localStorage.getItem(`${this.STORAGE_KEY}_private`);
      
      if (!savedPubKey || !savedPrivKey) {
        return null;
      }

      // 匯入公鑰
      const publicKeyData = base64ToArrayBuffer(savedPubKey);
      const publicKey = await crypto.subtle.importKey(
        'spki',
        publicKeyData,
        {
          name: 'ECDSA',
          namedCurve: 'P-256',
        },
        false,
        ['verify']
      );

      // 匯入私鑰
      const privateKeyData = base64ToArrayBuffer(savedPrivKey);
      const privateKey = await crypto.subtle.importKey(
        'pkcs8',
        privateKeyData,
        {
          name: 'ECDSA',
          namedCurve: 'P-256',
        },
        false,
        ['sign']
      );

      return { publicKey, privateKey };
    } catch (error) {
      console.warn('[IdentityManager] Failed to load key pair from storage', { error });
      return null;
    }
  }

  /**
   * 儲存密鑰對到 IndexedDB
   */
  private async saveKeyPairToStorage(keyPair: CryptoKeyPair): Promise<void> {
    try {
      // 匯出公鑰和私鑰
      const exportedPubKey = await crypto.subtle.exportKey('spki', keyPair.publicKey);
      const exportedPrivKey = await crypto.subtle.exportKey('pkcs8', keyPair.privateKey);
      
      // 儲存到 localStorage（簡化版，實際應該使用 IndexedDB）
      localStorage.setItem(`${this.STORAGE_KEY}_public`, arrayBufferToBase64(exportedPubKey));
      localStorage.setItem(`${this.STORAGE_KEY}_private`, arrayBufferToBase64(exportedPrivKey));
      
      console.log('[IdentityManager] Saved key pair to storage');
    } catch (error) {
      console.error('[IdentityManager] Failed to save key pair to storage', { error });
      throw error;
    }
  }
}
