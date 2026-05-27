import { arrayBufferToBase64, sha256Hash, base64ToArrayBuffer } from '../../utils/crypto';
import { logger } from '../../utils/logger';

const IDB_NAME = 'nerilo_identity';
const IDB_STORE = 'keypairs';
const IDB_KEY = 'mesh_default';

/**
 * IndexedDB-backed key-pair storage.
 *
 * What this DOES guarantee:
 *  - The in-memory CryptoKey for the private key is imported with
 *    extractable=false, so JS that holds the CryptoKey reference cannot
 *    call exportKey() on it.
 *  - Migration from legacy localStorage automatically clears the old
 *    key material.
 *
 * What this does NOT guarantee — be honest about it:
 *  - The raw PKCS8 bytes ARE persisted to IndexedDB unencrypted (see
 *    saveKeyPairToStorage below). The "extractable=false" flag only
 *    protects the CryptoKey object handed back to JS; anyone who can
 *    read the IndexedDB store (same-origin XSS, malicious browser
 *    extension, physical device access, DevTools) can read those bytes
 *    and re-import them with extractable=true to sign arbitrary messages.
 *  - This is intentional for persistence — losing the key on every page
 *    reload would be unusable — but it means the long-term identity is
 *    only as safe as the device.
 *
 * See docs/THREAT_MODEL.md ("Known limitations" #4) for the full analysis
 * and recommended user practices (hardware-locked device, browser updates).
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
 * Identity manager — generates and persists the long-term ECDSA P-256
 * key pair, and derives a stable userId = sha256(spki(pubKey))[:32].
 *
 * Security posture (read alongside the IndexedDB-storage notes above):
 * - Keys live in IndexedDB rather than localStorage, so they're scoped to
 *   the origin's IndexedDB sandbox and survive across reloads.
 * - The CryptoKey returned for the private key is non-extractable, so
 *   code holding the in-memory key cannot exportKey() it.
 * - The persisted PKCS8 bytes are NOT encrypted at rest — see the file-
 *   level docstring above and docs/THREAT_MODEL.md for the threat model.
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
   * Load the keypair from IndexedDB.
   *
   * The private CryptoKey is imported with extractable=false, which
   * prevents code that already holds the CryptoKey object from calling
   * exportKey() on it. This is NOT a defence against an attacker who can
   * read the underlying IndexedDB store — they can just re-import the
   * stored PKCS8 bytes with extractable=true. See the file-level
   * docstring and docs/THREAT_MODEL.md.
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
