/**
 * Hybrid Node Adapters — Type Definitions
 *
 * Abstracts browser-specific APIs so the core layer can run on:
 *   - Browser Node (existing): IndexedDB, WebRTC, SubtleCrypto
 *   - Desktop Daemon (Electron/Node.js): SQLite, ws/libp2p, node:crypto
 *   - Bootstrap Node (VPS/RPi): SQLite, ws/libp2p, node:crypto
 *
 * Each adapter interface has a Browser implementation (default) and
 * a Node.js implementation that can be swapped at initialization.
 */

// ── Storage Adapter ─────────────────────────────────────────────────────────

/**
 * Key-value storage abstraction.
 * Browser: IndexedDB / localStorage
 * Node.js: SQLite / file system
 */
export interface IStorageAdapter {
  /** Get a value by key. Returns undefined if not found. */
  get<T = unknown>(store: string, key: string): Promise<T | undefined>;

  /** Set a value by key. Creates or overwrites. */
  set<T = unknown>(store: string, key: string, value: T): Promise<void>;

  /** Delete a value by key. No-op if not found. */
  delete(store: string, key: string): Promise<void>;

  /** Check if a key exists. */
  has(store: string, key: string): Promise<boolean>;

  /** Get all keys in a store. */
  keys(store: string): Promise<string[]>;

  /** Get all values in a store. */
  getAll<T = unknown>(store: string): Promise<T[]>;

  /** Delete all entries in a store. */
  clear(store: string): Promise<void>;

  /** Close the storage (cleanup connections). */
  close(): Promise<void>;
}

// ── Crypto Adapter ──────────────────────────────────────────────────────────

/**
 * Cryptographic operations abstraction.
 * Browser: SubtleCrypto (crypto.subtle)
 * Node.js: node:crypto (webcrypto)
 */
export interface ICryptoAdapter {
  /** Generate random bytes. */
  getRandomBytes(length: number): Uint8Array;

  /** SHA-256 hash of input. */
  sha256(data: Uint8Array): Promise<ArrayBuffer>;

  /** Generate ECDH P-256 key pair. */
  generateECDHKeyPair(exportable?: boolean): Promise<CryptoKeyPair>;

  /** Generate AES-256-GCM key. */
  generateAESKey(exportable?: boolean): Promise<CryptoKey>;

  /** ECDH key derivation → AES-256-GCM key. */
  deriveSharedSecret(
    privateKey: CryptoKey,
    publicKey: CryptoKey
  ): Promise<CryptoKey>;

  /** AES-256-GCM encrypt. */
  encrypt(
    key: CryptoKey,
    data: ArrayBuffer,
    iv: Uint8Array
  ): Promise<ArrayBuffer>;

  /** AES-256-GCM decrypt. */
  decrypt(
    key: CryptoKey,
    data: ArrayBuffer,
    iv: Uint8Array
  ): Promise<ArrayBuffer>;

  /** Export a CryptoKey to raw bytes. */
  exportKey(format: 'raw' | 'pkcs8' | 'spki', key: CryptoKey): Promise<ArrayBuffer>;

  /** Import raw bytes as a CryptoKey. */
  importKey(
    format: 'raw' | 'pkcs8' | 'spki',
    data: ArrayBuffer,
    algorithm: AlgorithmIdentifier | EcKeyImportParams | AesKeyAlgorithm,
    extractable: boolean,
    usages: KeyUsage[]
  ): Promise<CryptoKey>;

  /** ECDSA sign. */
  sign(key: CryptoKey, data: ArrayBuffer): Promise<ArrayBuffer>;

  /** ECDSA verify. */
  verify(
    key: CryptoKey,
    signature: ArrayBuffer,
    data: ArrayBuffer
  ): Promise<boolean>;
}

// ── Network Adapter ─────────────────────────────────────────────────────────

/**
 * Network transport abstraction.
 * Browser: WebRTC DataChannel
 * Node.js: WebSocket / libp2p / TCP
 */
export interface INetworkAdapter {
  /** Connect to a peer. Returns a connection handle. */
  connect(peerId: string, config?: Record<string, unknown>): Promise<IConnection>;

  /** Listen for incoming connections. */
  onConnection(handler: (conn: IConnection) => void): () => void;

  /** Get the local peer ID. */
  getLocalId(): string;

  /** Check if a peer is connected. */
  isConnected(peerId: string): boolean;

  /** Get all connected peer IDs. */
  getConnectedPeers(): string[];

  /** Disconnect from a peer. */
  disconnect(peerId: string): Promise<void>;

  /** Shut down the network adapter. */
  close(): Promise<void>;
}

/**
 * Connection handle for a single peer link.
 */
export interface IConnection {
  /** Remote peer ID. */
  peerId: string;

  /** Send data to the peer. */
  send(data: string | ArrayBuffer): void;

  /** Register handler for incoming data. */
  onData(handler: (data: string | ArrayBuffer) => void): () => void;

  /** Register handler for connection close. */
  onClose(handler: () => void): () => void;

  /** Register handler for errors. */
  onError(handler: (error: Error) => void): () => void;

  /** Close this connection. */
  close(): void;

  /** Connection state. */
  readonly state: 'connecting' | 'open' | 'closing' | 'closed';
}

// ── Timer Adapter ───────────────────────────────────────────────────────────

/**
 * Timer/scheduler abstraction.
 * Browser: setTimeout/setInterval
 * Node.js: same API but different implementation details
 *
 * This exists mainly for testability and to support different
 * scheduling strategies (e.g., process.nextTick in Node.js).
 */
export interface ITimerAdapter {
  setTimeout(callback: () => void, ms: number): number;
  clearTimeout(id: number): void;
  setInterval(callback: () => void, ms: number): number;
  clearInterval(id: number): void;
  now(): number;
}

// ── Runtime Environment ─────────────────────────────────────────────────────

export type RuntimeType = 'browser' | 'node' | 'electron';

/**
 * Combined runtime environment providing all adapters.
 * This is the main entry point — swap the entire runtime to
 * switch between Browser, Desktop Daemon, and Bootstrap Node.
 */
export interface IRuntime {
  readonly type: RuntimeType;
  readonly storage: IStorageAdapter;
  readonly crypto: ICryptoAdapter;
  readonly network: INetworkAdapter;
  readonly timer: ITimerAdapter;
}
