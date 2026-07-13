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
  publicKeyData: string;  // Base64-encoded SPKI（ECDSA 簽章公鑰）
  privateKeyData: string; // Base64-encoded PKCS8（ECDSA 簽章私鑰）
  /** ECDH 公鑰 SPKI（Base64）；keyx 成對封裝用（ADR-0023 P2-②c）。舊 blob 無此欄位。 */
  ecdhPublicKeyData?: string;
  /** ECDH 私鑰 PKCS8（Base64）；與 ECDSA 私鑰同持久策略（見檔頭 threat model 註）。 */
  ecdhPrivateKeyData?: string;
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
   * ECDH P-256 金鑰對（keyx 成對封裝房間內容金鑰，ADR-0023 P2-②c）。
   * 與 ECDSA 身分金鑰分離：ECDSA 只能簽/驗，ECDH 只能協商，SubtleCrypto 不可混用。
   * 持久化 → 全員斷線重生後，日誌裡舊 keyx（封給舊 ECDH 公鑰）仍開得了 → 歷史金鑰可補齊
   * （「金鑰韌性 = 資料韌性」，ADR 修訂三）。持久失敗（Safari 隱私模式/node）退 session 內暫時金鑰。
   */
  private ecdhKeyPair: CryptoKeyPair | null = null;

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

    // ECDH 金鑰對（獨立於 ECDSA 身分）：載入或生成 + 持久化。
    // 失敗非致命——退 session 內暫時金鑰（該裝置重啟後無法解舊 epoch 歷史，已記錄的取捨）。
    await this.ensureEcdhKeyPair();
  }

  /** 取得 ECDH 公鑰（供 keyx 對外發布；未初始化拋錯）。 */
  getEcdhPublicKey(): CryptoKey {
    if (!this.ecdhKeyPair) {
      throw new Error('ECDH key pair not initialized. Call initialize() first.');
    }
    return this.ecdhKeyPair.publicKey;
  }

  /** 取得 ECDH 私鑰（供 openSealedRoomKey 開出封給自己的房間金鑰）。 */
  getEcdhPrivateKey(): CryptoKey {
    if (!this.ecdhKeyPair) {
      throw new Error('ECDH key pair not initialized. Call initialize() first.');
    }
    return this.ecdhKeyPair.privateKey;
  }

  /** 匯出 ECDH 公鑰（Base64 SPKI），寫入 meshIdentities.ecdhPubKey 供他人封裝。 */
  async exportEcdhPublicKey(): Promise<string> {
    if (!this.ecdhKeyPair) {
      throw new Error('ECDH key pair not initialized. Call initialize() first.');
    }
    const exported = await crypto.subtle.exportKey('spki', this.ecdhKeyPair.publicKey);
    return arrayBufferToBase64(exported);
  }

  /**
   * 確保 ECDH 金鑰對就緒：先試從 IndexedDB 載入既有；缺則生成並持久化（合併進既有 blob，
   * 不動 ECDSA 欄位）。持久失敗 → 記憶體內暫時金鑰，本 session 仍可 keyx。
   */
  private async ensureEcdhKeyPair(): Promise<void> {
    try {
      const db = await openIdentityDB();
      const stored = await idbGet<StoredKeyPair>(db, IDB_KEY);
      db.close();
      if (stored?.ecdhPublicKeyData && stored?.ecdhPrivateKeyData) {
        this.ecdhKeyPair = await this.importEcdhKeyPair(
          stored.ecdhPublicKeyData,
          stored.ecdhPrivateKeyData
        );
        logger.info('[IdentityManager] Loaded ECDH key pair from storage');
        return;
      }
    } catch (error) {
      logger.warn('[IdentityManager] ECDH load failed, will generate', { error });
    }

    // 生成新 ECDH 金鑰對（extractable：要匯出以持久化與發布公鑰）
    const gen = await crypto.subtle.generateKey(
      { name: 'ECDH', namedCurve: 'P-256' },
      true,
      ['deriveBits', 'deriveKey']
    );
    const pub = arrayBufferToBase64(await crypto.subtle.exportKey('spki', gen.publicKey));
    const priv = arrayBufferToBase64(await crypto.subtle.exportKey('pkcs8', gen.privateKey));

    try {
      await this.persistEcdhKeyPair(pub, priv);
      logger.info('[IdentityManager] Generated and persisted ECDH key pair');
    } catch (error) {
      logger.warn('[IdentityManager] ECDH persist failed — ephemeral (session-only) key', { error });
    }

    // 一律以「私鑰不可匯出」的形式載入到記憶體（安全對齊 ECDSA 私鑰）
    this.ecdhKeyPair = await this.importEcdhKeyPair(pub, priv);
  }

  /** 從 Base64 SPKI/PKCS8 匯入 ECDH 金鑰對；私鑰不可匯出（僅 deriveBits/deriveKey）。 */
  private async importEcdhKeyPair(pubB64: string, privB64: string): Promise<CryptoKeyPair> {
    const publicKey = await crypto.subtle.importKey(
      'spki',
      base64ToArrayBuffer(pubB64),
      { name: 'ECDH', namedCurve: 'P-256' },
      true, // 公鑰可匯出（exportEcdhPublicKey 發布用）
      [] // ECDH 公鑰無 key usages
    );
    const privateKey = await crypto.subtle.importKey(
      'pkcs8',
      base64ToArrayBuffer(privB64),
      { name: 'ECDH', namedCurve: 'P-256' },
      false, // 私鑰不可匯出
      ['deriveBits', 'deriveKey']
    );
    return { publicKey, privateKey };
  }

  /** 把 ECDH 金鑰材料合併寫回 IndexedDB blob（保留既有 ECDSA 欄位）。 */
  private async persistEcdhKeyPair(pubB64: string, privB64: string): Promise<void> {
    const db = await openIdentityDB();
    const existing = (await idbGet<StoredKeyPair>(db, IDB_KEY)) ?? undefined;
    if (!existing?.publicKeyData || !existing?.privateKeyData) {
      // 理論上 ECDSA 已先存；缺則不覆寫（避免寫出殘缺 blob），留待下次
      db.close();
      throw new Error('ECDSA key blob missing; skip ECDH merge');
    }
    await idbPut(db, IDB_KEY, {
      ...existing,
      ecdhPublicKeyData: pubB64,
      ecdhPrivateKeyData: privB64,
    });
    db.close();
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
