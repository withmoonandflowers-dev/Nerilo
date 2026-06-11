import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { RuntimeRegistry } from '../../src/core/adapters/RuntimeRegistry';
import { MemoryStorageAdapter, NodeCryptoAdapter, NodeRuntime } from '../../src/core/adapters/NodeRuntime';

// Note: We test NodeRuntime adapters here because they work in Vitest's Node.js env.
// BrowserRuntime adapters (IndexedDB, window.*) require a browser environment.

describe('RuntimeRegistry', () => {
  afterEach(() => {
    RuntimeRegistry.reset();
  });

  it('starts uninitialized', () => {
    expect(RuntimeRegistry.isInitialized()).toBe(false);
    expect(RuntimeRegistry.getType()).toBeNull();
  });

  it('initializes with a runtime', () => {
    const runtime = new NodeRuntime('node', 'test-id');
    RuntimeRegistry.init(runtime);

    expect(RuntimeRegistry.isInitialized()).toBe(true);
    expect(RuntimeRegistry.getType()).toBe('node');
    expect(RuntimeRegistry.get()).toBe(runtime);
  });

  it('throws on double init', () => {
    RuntimeRegistry.init(new NodeRuntime('node', 'id1'));
    expect(() => RuntimeRegistry.init(new NodeRuntime('node', 'id2')))
      .toThrow('already initialized');
  });

  it('throws on get before init', () => {
    expect(() => RuntimeRegistry.get()).toThrow('not initialized');
  });

  it('resets correctly', () => {
    RuntimeRegistry.init(new NodeRuntime('node', 'id'));
    RuntimeRegistry.reset();

    expect(RuntimeRegistry.isInitialized()).toBe(false);
    expect(RuntimeRegistry.getType()).toBeNull();
  });

  it('allows re-init after reset', () => {
    RuntimeRegistry.init(new NodeRuntime('node', 'id1'));
    RuntimeRegistry.reset();
    RuntimeRegistry.init(new NodeRuntime('electron', 'id2'));

    expect(RuntimeRegistry.getType()).toBe('electron');
  });
});

describe('MemoryStorageAdapter', () => {
  let storage: MemoryStorageAdapter;

  beforeEach(() => {
    storage = new MemoryStorageAdapter();
  });

  it('sets and gets values', async () => {
    await storage.set('users', 'alice', { name: 'Alice', age: 30 });
    const result = await storage.get<{ name: string; age: number }>('users', 'alice');
    expect(result).toEqual({ name: 'Alice', age: 30 });
  });

  it('returns undefined for missing keys', async () => {
    const result = await storage.get('users', 'nonexistent');
    expect(result).toBeUndefined();
  });

  it('overwrites existing values', async () => {
    await storage.set('users', 'alice', { v: 1 });
    await storage.set('users', 'alice', { v: 2 });
    const result = await storage.get<{ v: number }>('users', 'alice');
    expect(result).toEqual({ v: 2 });
  });

  it('deletes values', async () => {
    await storage.set('users', 'alice', 'data');
    await storage.delete('users', 'alice');
    expect(await storage.has('users', 'alice')).toBe(false);
  });

  it('checks existence with has()', async () => {
    expect(await storage.has('store', 'key')).toBe(false);
    await storage.set('store', 'key', 'val');
    expect(await storage.has('store', 'key')).toBe(true);
  });

  it('lists keys', async () => {
    await storage.set('msgs', 'a', 1);
    await storage.set('msgs', 'b', 2);
    await storage.set('msgs', 'c', 3);

    const keys = await storage.keys('msgs');
    expect(keys.sort()).toEqual(['a', 'b', 'c']);
  });

  it('gets all values', async () => {
    await storage.set('data', 'x', 10);
    await storage.set('data', 'y', 20);

    const all = await storage.getAll<number>('data');
    expect(all.sort()).toEqual([10, 20]);
  });

  it('clears a store', async () => {
    await storage.set('temp', 'a', 1);
    await storage.set('temp', 'b', 2);
    await storage.clear('temp');

    expect(await storage.keys('temp')).toEqual([]);
  });

  it('isolates stores', async () => {
    await storage.set('storeA', 'key', 'A');
    await storage.set('storeB', 'key', 'B');

    expect(await storage.get('storeA', 'key')).toBe('A');
    expect(await storage.get('storeB', 'key')).toBe('B');
  });

  it('close clears all', async () => {
    await storage.set('s', 'k', 'v');
    await storage.close();
    expect(await storage.keys('s')).toEqual([]);
  });
});

describe('NodeCryptoAdapter', () => {
  let crypto: NodeCryptoAdapter;

  beforeEach(() => {
    crypto = new NodeCryptoAdapter();
  });

  it('generates random bytes', () => {
    const bytes = crypto.getRandomBytes(32);
    expect(bytes).toBeInstanceOf(Uint8Array);
    expect(bytes.length).toBe(32);

    // Should not be all zeros
    expect(bytes.some(b => b !== 0)).toBe(true);
  });

  it('generates different random bytes each time', () => {
    const a = crypto.getRandomBytes(16);
    const b = crypto.getRandomBytes(16);
    expect(a).not.toEqual(b);
  });

  it('computes SHA-256', async () => {
    const data = new TextEncoder().encode('hello world');
    const hash = await crypto.sha256(data);
    expect(hash.byteLength).toBe(32);
  });

  it('produces consistent SHA-256 for same input', async () => {
    const data = new TextEncoder().encode('test');
    const h1 = await crypto.sha256(data);
    const h2 = await crypto.sha256(data);
    expect(new Uint8Array(h1)).toEqual(new Uint8Array(h2));
  });

  it('generates ECDH key pair', async () => {
    const kp = await crypto.generateECDHKeyPair();
    expect(kp.publicKey).toBeTruthy();
    expect(kp.privateKey).toBeTruthy();
  });

  it('generates AES key', async () => {
    const key = await crypto.generateAESKey(true);
    expect(key).toBeTruthy();
  });

  it('encrypts and decrypts with AES-GCM', async () => {
    const key = await crypto.generateAESKey(true);
    const plaintext = new TextEncoder().encode('secret message');
    const iv = crypto.getRandomBytes(12);

    const ciphertext = await crypto.encrypt(key, plaintext.buffer as ArrayBuffer, iv);
    expect(ciphertext.byteLength).toBeGreaterThan(0);

    const decrypted = await crypto.decrypt(key, ciphertext, iv);
    const result = new TextDecoder().decode(decrypted);
    expect(result).toBe('secret message');
  });

  it('derives shared secret via ECDH', async () => {
    const alice = await crypto.generateECDHKeyPair();
    const bob = await crypto.generateECDHKeyPair();

    const sharedA = await crypto.deriveSharedSecret(alice.privateKey, bob.publicKey);
    const sharedB = await crypto.deriveSharedSecret(bob.privateKey, alice.publicKey);

    // Both should derive valid AES keys
    expect(sharedA).toBeTruthy();
    expect(sharedB).toBeTruthy();

    // Verify they produce same encryption results
    const iv = crypto.getRandomBytes(12);
    const data = new TextEncoder().encode('test').buffer as ArrayBuffer;
    const encA = await crypto.encrypt(sharedA, data, iv);
    const decB = await crypto.decrypt(sharedB, encA, iv);
    expect(new TextDecoder().decode(decB)).toBe('test');
  });

  it('exports and imports keys', async () => {
    const key = await crypto.generateAESKey(true);
    const raw = await crypto.exportKey('raw', key);
    expect(raw.byteLength).toBe(32); // 256 bits

    const imported = await crypto.importKey(
      'raw',
      raw,
      { name: 'AES-GCM', length: 256 },
      true,
      ['encrypt', 'decrypt']
    );
    expect(imported).toBeTruthy();
  });

  it('signs and verifies with ECDSA', async () => {
    // ECDSA needs a signing key pair (not ECDH)
    const kp = await globalThis.crypto.subtle.generateKey(
      { name: 'ECDSA', namedCurve: 'P-256' },
      false,
      ['sign', 'verify']
    );

    const data = new TextEncoder().encode('message to sign').buffer as ArrayBuffer;
    const sig = await crypto.sign(kp.privateKey, data);
    expect(sig.byteLength).toBeGreaterThan(0);

    const valid = await crypto.verify(kp.publicKey, sig, data);
    expect(valid).toBe(true);

    // Tampered data should fail
    const tampered = new TextEncoder().encode('tampered message').buffer as ArrayBuffer;
    const invalid = await crypto.verify(kp.publicKey, sig, tampered);
    expect(invalid).toBe(false);
  });
});

describe('NodeRuntime (integration)', () => {
  it('creates a complete runtime with deviceCapability', () => {
    const runtime = new NodeRuntime('node', 'local-id');
    expect(runtime.type).toBe('node');
    expect(runtime.storage).toBeTruthy();
    expect(runtime.crypto).toBeTruthy();
    expect(runtime.network).toBeTruthy();
    expect(runtime.timer).toBeTruthy();
    expect(runtime.deviceCapability).toBeTruthy();
  });

  it('creates electron runtime', () => {
    const runtime = new NodeRuntime('electron', 'local-id');
    expect(runtime.type).toBe('electron');
  });

  it('network adapter returns local ID', () => {
    const runtime = new NodeRuntime('node', 'my-peer-id');
    expect(runtime.network.getLocalId()).toBe('my-peer-id');
  });

  it('timer adapter works', () => {
    const runtime = new NodeRuntime('node', 'id');
    expect(runtime.timer.now()).toBeGreaterThan(0);
  });
});
