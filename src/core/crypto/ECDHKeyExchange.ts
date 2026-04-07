/**
 * ECDH P-256 Key Exchange
 * Derives shared secrets for encrypting sender key distribution.
 *
 * Uses browser-native SubtleCrypto:
 * - ECDH P-256 for key agreement
 * - HKDF to derive AES-256-GCM key from shared secret
 * - AES-256-GCM for encryption/decryption
 */

/** Derive a shared AES-256-GCM key from ECDH key agreement */
export async function deriveSharedSecret(
  myPrivateKey: CryptoKey,
  theirPublicKey: CryptoKey
): Promise<CryptoKey> {
  // ECDH key agreement → raw shared secret
  const sharedBits = await crypto.subtle.deriveBits(
    { name: 'ECDH', public: theirPublicKey },
    myPrivateKey,
    256
  );

  // Import as HKDF key material
  const hkdfKey = await crypto.subtle.importKey(
    'raw',
    sharedBits,
    'HKDF',
    false,
    ['deriveKey']
  );

  // HKDF → AES-256-GCM
  const aesKey = await crypto.subtle.deriveKey(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: new TextEncoder().encode('nerilo-sender-key-v1'),
      info: new TextEncoder().encode('sender-key-encryption'),
    },
    hkdfKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );

  return aesKey;
}

/** Encrypt data for a specific peer using the derived shared secret */
export async function encryptForPeer(
  data: ArrayBuffer,
  sharedSecret: CryptoKey
): Promise<{ ciphertext: ArrayBuffer; iv: Uint8Array }> {
  const iv = crypto.getRandomValues(new Uint8Array(12));

  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    sharedSecret,
    data
  );

  return { ciphertext, iv };
}

/** Decrypt data from a peer using the derived shared secret */
export async function decryptFromPeer(
  ciphertext: ArrayBuffer,
  iv: Uint8Array,
  sharedSecret: CryptoKey
): Promise<ArrayBuffer> {
  return crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: iv as Uint8Array<ArrayBuffer> },
    sharedSecret,
    ciphertext
  );
}
