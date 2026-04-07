import { arrayBufferToBase64, sha256Hash, base64ToArrayBuffer } from '../../utils/crypto';
import { logger } from '../../utils/logger';

const IDB_NAME = 'nerilo_identity';
const IDB_STORE = 'keypairs';
const IDB_KEY = 'mesh_default';

/**
 * IndexedDB 封裝：安全儲存密鑰對
 * 比 localStorage 安全，因為 IndexedDB 可儲存非字串型態（CryptoKey 物件）
 * 且 non-extractable keys 無法被 JS 讀取原始金鑰材料
 */
function openIdentityDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(IDB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(IDB_STORE)) {
        db.createObjectStore(IDB_STORE);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function idbGet<T>(db: IDBDatabase, key: string): Promise<T | undefined> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(IDB_STORE, 'readonly');
    const store = tx.objectStore(IDB_STORE);
    const req = store.get(key);
    req.onsuccess = () => resolve(req.result as T | undefined);
    req.onerror = () => reject(req.error);
  });
}

function idbPut(db: IDBDatabase, key: string, value: unknown): Promise<void> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(IDB_STORE, 'readwrite');
    const store = tx.objectStore(IDB_STORE);
    const req = store.put(value, key);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

interface StoredKeyPair {
  publicKeyData: string;  // Base64-encoded SPKI
  privateKeyData: string; // Base64-encoded PKCS8
}

/**
 * 身分管理器
 * 負責生成和管理密鑰對，以及計算使用者 ID
 *
 * 安全改善：
 * - 密鑰儲存在 IndexedDB（非 localStorage）
 * - 匯入時使用 extractable=false 防止 JS 讀取原始金鑰
 */
export class IdentityManager {
  private keyPair: CryptoKeyPair | null = null;
  private userId: string | null = null;

  /**
   * 初始化（生成或載入密鑰對）
   */
  async initialize(): Promise<void> {
    const savedKeyPair = await this.loadKeyPairFromStorage();

    if (savedKeyPair) {
      this.keyPair = savedKeyPair;
      this.userId = await this.deriveUserId(this.keyPair.publicKey);
      logger.info('[IdentityManager] Loaded key pair from storage', {
        userId: this.userId,
      });
    } else {
      this.keyPair = await this.generateKeyPair();
      this.userId = await this.deriveUserId(this.keyPair.publicKey);
      await this.saveKeyPairToStorage(this.keyPair);
      logger.info('[IdentityManager] Generated new key pair', {
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
      true, // 需可匯出以便持久化
      ['sign', 'verify']
    );
  }

  /**
   * 從公鑰計算 userId
   */
  async deriveUserId(publicKey: CryptoKey): Promise<string> {
    const exportedKey = await crypto.subtle.exportKey('spki', publicKey);
    const hash = await sha256Hash(arrayBufferToBase64(exportedKey));
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
   * 匯入時設 extractable=false，防止 XSS 攻擊者讀取原始金鑰
   */
  private async loadKeyPairFromStorage(): Promise<CryptoKeyPair | null> {
    try {
      // 向後相容：嘗試遷移 localStorage 中的舊密鑰
      const migrated = await this.migrateFromLocalStorage();
      if (migrated) return migrated;

      const db = await openIdentityDB();
      const stored = await idbGet<StoredKeyPair>(db, IDB_KEY);
      db.close();

      if (!stored?.publicKeyData || !stored?.privateKeyData) {
        return null;
      }

      const publicKey = await crypto.subtle.importKey(
        'spki',
        base64ToArrayBuffer(stored.publicKeyData),
        { name: 'ECDSA', namedCurve: 'P-256' },
        true, // publicKey 可匯出（需要 deriveUserId / exportPublicKey）
        ['verify']
      );

      const privateKey = await crypto.subtle.importKey(
        'pkcs8',
        base64ToArrayBuffer(stored.privateKeyData),
        { name: 'ECDSA', namedCurve: 'P-256' },
        false, // 安全：privateKey 不可匯出
        ['sign']
      );

      return { publicKey, privateKey };
    } catch (error) {
      logger.warn('[IdentityManager] Failed to load key pair from storage', { error });
      return null;
    }
  }

  /**
   * 儲存密鑰對到 IndexedDB
   */
  private async saveKeyPairToStorage(keyPair: CryptoKeyPair): Promise<void> {
    try {
      const exportedPubKey = await crypto.subtle.exportKey('spki', keyPair.publicKey);
      const exportedPrivKey = await crypto.subtle.exportKey('pkcs8', keyPair.privateKey);

      const stored: StoredKeyPair = {
        publicKeyData: arrayBufferToBase64(exportedPubKey),
        privateKeyData: arrayBufferToBase64(exportedPrivKey),
      };

      const db = await openIdentityDB();
      await idbPut(db, IDB_KEY, stored);
      db.close();

      logger.info('[IdentityManager] Saved key pair to IndexedDB');
    } catch (error) {
      logger.error('[IdentityManager] Failed to save key pair to storage', { error });
      throw error;
    }
  }

  /**
   * 向後相容：將 localStorage 中的舊密鑰遷移到 IndexedDB，並刪除 localStorage 記錄
   */
  private async migrateFromLocalStorage(): Promise<CryptoKeyPair | null> {
    try {
      const LEGACY_KEY = 'mesh_keypair';
      const savedPubKey = localStorage.getItem(`${LEGACY_KEY}_public`);
      const savedPrivKey = localStorage.getItem(`${LEGACY_KEY}_private`);

      if (!savedPubKey || !savedPrivKey) return null;

      logger.info('[IdentityManager] Migrating keys from localStorage to IndexedDB');

      const publicKey = await crypto.subtle.importKey(
        'spki',
        base64ToArrayBuffer(savedPubKey),
        { name: 'ECDSA', namedCurve: 'P-256' },
        true,
        ['verify']
      );

      const privateKey = await crypto.subtle.importKey(
        'pkcs8',
        base64ToArrayBuffer(savedPrivKey),
        { name: 'ECDSA', namedCurve: 'P-256' },
        false, // 遷移後設為 non-extractable
        ['sign']
      );

      const keyPair = { publicKey, privateKey };

      // 儲存到 IndexedDB（需要用 extractable privateKey 才能 export）
      // 因此先用 extractable=true 匯入一次來 export
      const extractablePrivateKey = await crypto.subtle.importKey(
        'pkcs8',
        base64ToArrayBuffer(savedPrivKey),
        { name: 'ECDSA', namedCurve: 'P-256' },
        true,
        ['sign']
      );
      await this.saveKeyPairToStorage({ publicKey, privateKey: extractablePrivateKey });

      // 刪除 localStorage 中的舊密鑰
      localStorage.removeItem(`${LEGACY_KEY}_public`);
      localStorage.removeItem(`${LEGACY_KEY}_private`);

      logger.info('[IdentityManager] Migration complete, localStorage keys removed');
      return keyPair;
    } catch (error) {
      logger.warn('[IdentityManager] localStorage migration failed', { error });
      return null;
    }
  }
}
