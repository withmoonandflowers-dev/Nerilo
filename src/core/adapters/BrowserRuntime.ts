/**
 * BrowserRuntime — Default browser-based adapter implementations
 *
 * Uses native browser APIs:
 *   - Storage: IndexedDB (via simple key-value wrapper)
 *   - Crypto: SubtleCrypto (crypto.subtle)
 *   - Network: WebRTC (RTCPeerConnection + RTCDataChannel)
 *   - Timer: window.setTimeout / setInterval
 */

import type {
  IRuntime,
  IStorageAdapter,
  ICryptoAdapter,
  INetworkAdapter,
  IConnection,
  ITimerAdapter,
} from './types';

// ── Browser Storage (IndexedDB) ─────────────────────────────────────────────

export class BrowserStorageAdapter implements IStorageAdapter {
  private dbName: string;
  private db: IDBDatabase | null = null;

  constructor(dbName = 'nerilo-storage') {
    this.dbName = dbName;
  }

  private async getDB(): Promise<IDBDatabase> {
    if (this.db) return this.db;

    return new Promise((resolve, reject) => {
      const request = indexedDB.open(this.dbName, 1);
      request.onupgradeneeded = () => {
        const db = request.result;
        // Create a generic object store if it doesn't exist
        if (!db.objectStoreNames.contains('kv')) {
          db.createObjectStore('kv');
        }
      };
      request.onsuccess = () => {
        this.db = request.result;
        resolve(this.db);
      };
      request.onerror = () => reject(request.error);
    });
  }

  private getStoreKey(store: string, key: string): string {
    return `${store}::${key}`;
  }

  async get<T = unknown>(store: string, key: string): Promise<T | undefined> {
    const db = await this.getDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('kv', 'readonly');
      const req = tx.objectStore('kv').get(this.getStoreKey(store, key));
      req.onsuccess = () => resolve(req.result as T | undefined);
      req.onerror = () => reject(req.error);
    });
  }

  async set<T = unknown>(store: string, key: string, value: T): Promise<void> {
    const db = await this.getDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('kv', 'readwrite');
      tx.objectStore('kv').put(value, this.getStoreKey(store, key));
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  async delete(store: string, key: string): Promise<void> {
    const db = await this.getDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('kv', 'readwrite');
      tx.objectStore('kv').delete(this.getStoreKey(store, key));
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  async has(store: string, key: string): Promise<boolean> {
    const val = await this.get(store, key);
    return val !== undefined;
  }

  async keys(store: string): Promise<string[]> {
    const db = await this.getDB();
    const prefix = `${store}::`;
    return new Promise((resolve, reject) => {
      const tx = db.transaction('kv', 'readonly');
      const req = tx.objectStore('kv').getAllKeys();
      req.onsuccess = () => {
        const allKeys = req.result as string[];
        resolve(
          allKeys
            .filter(k => typeof k === 'string' && k.startsWith(prefix))
            .map(k => (k as string).slice(prefix.length))
        );
      };
      req.onerror = () => reject(req.error);
    });
  }

  async getAll<T = unknown>(store: string): Promise<T[]> {
    const allKeys = await this.keys(store);
    const results: T[] = [];
    for (const key of allKeys) {
      const val = await this.get<T>(store, key);
      if (val !== undefined) results.push(val);
    }
    return results;
  }

  async clear(store: string): Promise<void> {
    const allKeys = await this.keys(store);
    for (const key of allKeys) {
      await this.delete(store, key);
    }
  }

  async close(): Promise<void> {
    this.db?.close();
    this.db = null;
  }
}

// ── Browser Crypto (SubtleCrypto) ───────────────────────────────────────────

export class BrowserCryptoAdapter implements ICryptoAdapter {
  getRandomBytes(length: number): Uint8Array {
    const bytes = new Uint8Array(length);
    crypto.getRandomValues(bytes);
    return bytes;
  }

  async sha256(data: Uint8Array): Promise<ArrayBuffer> {
    return crypto.subtle.digest('SHA-256', data as Uint8Array<ArrayBuffer>);
  }

  async generateECDHKeyPair(exportable = false): Promise<CryptoKeyPair> {
    return crypto.subtle.generateKey(
      { name: 'ECDH', namedCurve: 'P-256' },
      exportable,
      ['deriveKey', 'deriveBits']
    );
  }

  async generateAESKey(exportable = false): Promise<CryptoKey> {
    return crypto.subtle.generateKey(
      { name: 'AES-GCM', length: 256 },
      exportable,
      ['encrypt', 'decrypt']
    );
  }

  async deriveSharedSecret(
    privateKey: CryptoKey,
    publicKey: CryptoKey
  ): Promise<CryptoKey> {
    const sharedBits = await crypto.subtle.deriveBits(
      { name: 'ECDH', public: publicKey },
      privateKey,
      256
    );

    const hkdfKey = await crypto.subtle.importKey(
      'raw',
      sharedBits,
      'HKDF',
      false,
      ['deriveKey']
    );

    const salt = new TextEncoder().encode('nerilo-sender-key-v1');
    const info = new TextEncoder().encode('sender-key-encryption');
    return crypto.subtle.deriveKey(
      {
        name: 'HKDF',
        hash: 'SHA-256',
        salt: salt.buffer as ArrayBuffer,
        info: info.buffer as ArrayBuffer,
      },
      hkdfKey,
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt', 'decrypt']
    );
  }

  async encrypt(
    key: CryptoKey,
    data: ArrayBuffer,
    iv: Uint8Array
  ): Promise<ArrayBuffer> {
    return crypto.subtle.encrypt({ name: 'AES-GCM', iv: iv as Uint8Array<ArrayBuffer> }, key, data);
  }

  async decrypt(
    key: CryptoKey,
    data: ArrayBuffer,
    iv: Uint8Array
  ): Promise<ArrayBuffer> {
    return crypto.subtle.decrypt({ name: 'AES-GCM', iv: iv as Uint8Array<ArrayBuffer> }, key, data);
  }

  async exportKey(
    format: 'raw' | 'pkcs8' | 'spki',
    key: CryptoKey
  ): Promise<ArrayBuffer> {
    return crypto.subtle.exportKey(format, key);
  }

  async importKey(
    format: 'raw' | 'pkcs8' | 'spki',
    data: ArrayBuffer,
    algorithm: AlgorithmIdentifier | EcKeyImportParams | AesKeyAlgorithm,
    extractable: boolean,
    usages: KeyUsage[]
  ): Promise<CryptoKey> {
    return crypto.subtle.importKey(format, data, algorithm, extractable, usages);
  }

  async sign(key: CryptoKey, data: ArrayBuffer): Promise<ArrayBuffer> {
    return crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, data);
  }

  async verify(
    key: CryptoKey,
    signature: ArrayBuffer,
    data: ArrayBuffer
  ): Promise<boolean> {
    return crypto.subtle.verify(
      { name: 'ECDSA', hash: 'SHA-256' },
      key,
      signature,
      data
    );
  }
}

// ── Browser Network (WebRTC stub) ───────────────────────────────────────────

/**
 * Browser network adapter — stub implementation.
 * The actual WebRTC connections are managed by P2PConnectionManager;
 * this adapter provides the INetworkAdapter interface for future
 * node-type-agnostic code paths.
 */
export class BrowserNetworkAdapter implements INetworkAdapter {
  private localId: string;
  private connectionHandlers = new Set<(conn: IConnection) => void>();

  constructor(localId: string) {
    this.localId = localId;
  }

  async connect(_peerId: string, _config?: Record<string, unknown>): Promise<IConnection> {
    // In browser, connections are managed by P2PConnectionManager
    // This is a placeholder for the unified adapter interface
    throw new Error(
      'BrowserNetworkAdapter.connect() is a stub. Use P2PConnectionManager for WebRTC connections.'
    );
  }

  onConnection(handler: (conn: IConnection) => void): () => void {
    this.connectionHandlers.add(handler);
    return () => this.connectionHandlers.delete(handler);
  }

  getLocalId(): string {
    return this.localId;
  }

  isConnected(_peerId: string): boolean {
    return false; // Delegate to P2PConnectionManager
  }

  getConnectedPeers(): string[] {
    return []; // Delegate to P2PConnectionManager
  }

  async disconnect(_peerId: string): Promise<void> {
    // Delegate to P2PConnectionManager
  }

  async close(): Promise<void> {
    this.connectionHandlers.clear();
  }
}

// ── Browser Timer ───────────────────────────────────────────────────────────

export class BrowserTimerAdapter implements ITimerAdapter {
  setTimeout(callback: () => void, ms: number): number {
    return window.setTimeout(callback, ms) as unknown as number;
  }

  clearTimeout(id: number): void {
    window.clearTimeout(id);
  }

  setInterval(callback: () => void, ms: number): number {
    return window.setInterval(callback, ms) as unknown as number;
  }

  clearInterval(id: number): void {
    window.clearInterval(id);
  }

  now(): number {
    return Date.now();
  }
}

// ── Browser Runtime (Composite) ─────────────────────────────────────────────

export class BrowserRuntime implements IRuntime {
  readonly type = 'browser' as const;
  readonly storage: IStorageAdapter;
  readonly crypto: ICryptoAdapter;
  readonly network: INetworkAdapter;
  readonly timer: ITimerAdapter;

  constructor(localId: string, dbName?: string) {
    this.storage = new BrowserStorageAdapter(dbName);
    this.crypto = new BrowserCryptoAdapter();
    this.network = new BrowserNetworkAdapter(localId);
    this.timer = new BrowserTimerAdapter();
  }
}
