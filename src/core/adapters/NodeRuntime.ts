/**
 * NodeRuntime — Node.js / Electron adapter implementations
 *
 * Provides the same IRuntime interface using Node.js-compatible APIs:
 *   - Storage: In-memory Map (production: SQLite via better-sqlite3)
 *   - Crypto: Node.js webcrypto (globalThis.crypto or node:crypto)
 *   - Network: Placeholder for WebSocket/libp2p transport
 *   - Timer: Node.js setTimeout/setInterval
 *
 * Usage:
 *   Desktop Daemon: new NodeRuntime('node', localId)
 *   Bootstrap Node:  new NodeRuntime('node', localId)
 *   Electron:        new NodeRuntime('electron', localId)
 */

import type {
  IRuntime,
  IStorageAdapter,
  ICryptoAdapter,
  INetworkAdapter,
  IConnection,
  ITimerAdapter,
  RuntimeType,
} from './types';

// ── Node Storage (In-Memory / SQLite-ready) ─────────────────────────────────

/**
 * In-memory storage adapter for Node.js.
 * Drop-in replacement interface for SQLite — swap this class
 * with a SQLite-backed implementation when ready.
 */
export class MemoryStorageAdapter implements IStorageAdapter {
  private stores = new Map<string, Map<string, unknown>>();

  private getStore(store: string): Map<string, unknown> {
    let s = this.stores.get(store);
    if (!s) {
      s = new Map();
      this.stores.set(store, s);
    }
    return s;
  }

  async get<T = unknown>(store: string, key: string): Promise<T | undefined> {
    return this.getStore(store).get(key) as T | undefined;
  }

  async set<T = unknown>(store: string, key: string, value: T): Promise<void> {
    this.getStore(store).set(key, value);
  }

  async delete(store: string, key: string): Promise<void> {
    this.getStore(store).delete(key);
  }

  async has(store: string, key: string): Promise<boolean> {
    return this.getStore(store).has(key);
  }

  async keys(store: string): Promise<string[]> {
    return [...this.getStore(store).keys()];
  }

  async getAll<T = unknown>(store: string): Promise<T[]> {
    return [...this.getStore(store).values()] as T[];
  }

  async clear(store: string): Promise<void> {
    this.stores.delete(store);
  }

  async close(): Promise<void> {
    this.stores.clear();
  }
}

// ── Node Crypto (webcrypto) ─────────────────────────────────────────────────

/**
 * Node.js crypto adapter using globalThis.crypto (Node.js 19+)
 * or the webcrypto shim from node:crypto.
 *
 * The SubtleCrypto API is available in Node.js 15+ via
 * `require('node:crypto').webcrypto` and in Node.js 19+ via
 * `globalThis.crypto`. Same API surface as browser SubtleCrypto.
 */
export class NodeCryptoAdapter implements ICryptoAdapter {
  private subtle: SubtleCrypto;

  constructor() {
    // Use globalThis.crypto.subtle (available in Node 19+ and all browsers)
    // Falls back to node:crypto.webcrypto.subtle if needed
    if (typeof globalThis.crypto?.subtle !== 'undefined') {
      this.subtle = globalThis.crypto.subtle;
    } else {
      throw new Error(
        'SubtleCrypto not available. Requires Node.js 19+ or a webcrypto polyfill.'
      );
    }
  }

  getRandomBytes(length: number): Uint8Array {
    const bytes = new Uint8Array(length);
    globalThis.crypto.getRandomValues(bytes);
    return bytes;
  }

  async sha256(data: Uint8Array): Promise<ArrayBuffer> {
    return this.subtle.digest('SHA-256', data as Uint8Array<ArrayBuffer>);
  }

  async generateECDHKeyPair(exportable = false): Promise<CryptoKeyPair> {
    return this.subtle.generateKey(
      { name: 'ECDH', namedCurve: 'P-256' },
      exportable,
      ['deriveKey', 'deriveBits']
    );
  }

  async generateAESKey(exportable = false): Promise<CryptoKey> {
    return this.subtle.generateKey(
      { name: 'AES-GCM', length: 256 },
      exportable,
      ['encrypt', 'decrypt']
    );
  }

  async deriveSharedSecret(
    privateKey: CryptoKey,
    publicKey: CryptoKey
  ): Promise<CryptoKey> {
    const sharedBits = await this.subtle.deriveBits(
      { name: 'ECDH', public: publicKey },
      privateKey,
      256
    );

    const hkdfKey = await this.subtle.importKey(
      'raw',
      sharedBits,
      'HKDF',
      false,
      ['deriveKey']
    );

    const salt = new TextEncoder().encode('nerilo-sender-key-v1');
    const info = new TextEncoder().encode('sender-key-encryption');
    return this.subtle.deriveKey(
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
    return this.subtle.encrypt({ name: 'AES-GCM', iv: iv as Uint8Array<ArrayBuffer> }, key, data);
  }

  async decrypt(
    key: CryptoKey,
    data: ArrayBuffer,
    iv: Uint8Array
  ): Promise<ArrayBuffer> {
    return this.subtle.decrypt({ name: 'AES-GCM', iv: iv as Uint8Array<ArrayBuffer> }, key, data);
  }

  async exportKey(
    format: 'raw' | 'pkcs8' | 'spki',
    key: CryptoKey
  ): Promise<ArrayBuffer> {
    return this.subtle.exportKey(format, key);
  }

  async importKey(
    format: 'raw' | 'pkcs8' | 'spki',
    data: ArrayBuffer,
    algorithm: AlgorithmIdentifier | EcKeyImportParams | AesKeyAlgorithm,
    extractable: boolean,
    usages: KeyUsage[]
  ): Promise<CryptoKey> {
    return this.subtle.importKey(format, data, algorithm, extractable, usages);
  }

  async sign(key: CryptoKey, data: ArrayBuffer): Promise<ArrayBuffer> {
    return this.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, data);
  }

  async verify(
    key: CryptoKey,
    signature: ArrayBuffer,
    data: ArrayBuffer
  ): Promise<boolean> {
    return this.subtle.verify(
      { name: 'ECDSA', hash: 'SHA-256' },
      key,
      signature,
      data
    );
  }
}

// ── Node Network (WebSocket stub) ───────────────────────────────────────────

/**
 * Node.js network adapter — stub implementation.
 * Production: replace with WebSocket (ws) or libp2p transport.
 */
export class NodeNetworkAdapter implements INetworkAdapter {
  private localId: string;
  private connectionHandlers = new Set<(conn: IConnection) => void>();

  constructor(localId: string) {
    this.localId = localId;
  }

  async connect(_peerId: string, _config?: Record<string, unknown>): Promise<IConnection> {
    throw new Error(
      'NodeNetworkAdapter.connect() is a stub. Implement WebSocket or libp2p transport.'
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
    return false;
  }

  getConnectedPeers(): string[] {
    return [];
  }

  async disconnect(_peerId: string): Promise<void> {
    // stub
  }

  async close(): Promise<void> {
    this.connectionHandlers.clear();
  }
}

// ── Node Timer ──────────────────────────────────────────────────────────────

export class NodeTimerAdapter implements ITimerAdapter {
  setTimeout(callback: () => void, ms: number): number {
    return globalThis.setTimeout(callback, ms) as unknown as number;
  }

  clearTimeout(id: number): void {
    globalThis.clearTimeout(id);
  }

  setInterval(callback: () => void, ms: number): number {
    return globalThis.setInterval(callback, ms) as unknown as number;
  }

  clearInterval(id: number): void {
    globalThis.clearInterval(id);
  }

  now(): number {
    return Date.now();
  }
}

// ── Node Runtime (Composite) ────────────────────────────────────────────────

export class NodeRuntime implements IRuntime {
  readonly type: RuntimeType;
  readonly storage: IStorageAdapter;
  readonly crypto: ICryptoAdapter;
  readonly network: INetworkAdapter;
  readonly timer: ITimerAdapter;

  constructor(type: 'node' | 'electron', localId: string) {
    this.type = type;
    this.storage = new MemoryStorageAdapter();
    this.crypto = new NodeCryptoAdapter();
    this.network = new NodeNetworkAdapter(localId);
    this.timer = new NodeTimerAdapter();
  }
}
