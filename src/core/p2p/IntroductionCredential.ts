/**
 * Spec 030 的純協議原語。
 *
 * 本檔只簽驗介紹憑證與 subject 持鑰證明，不寫入房籍，也不把驗證成功
 * 等同私有房已授權。跨驗證者 nonce 收斂尚未定案，本階段只有本機冪等追蹤。
 */
import { arrayBufferToBase64, base64ToArrayBuffer, sha256Hash } from '../../utils/crypto';

export const INTRODUCTION_CREDENTIAL_MAX_AGE_MS = 300_000;
export const INTRODUCTION_CLOCK_SKEW_MS = 30_000;
export const INTRODUCTION_CHALLENGE_MAX_AGE_MS = 30_000;

export interface IntroductionParty {
  uid: string;
  nodeId: string;
  pubKey: string;
}

export interface IntroductionSubject extends IntroductionParty {
  ecdhPubKey: string;
}

export interface UnsignedIntroductionCredential {
  v: 'nintro1';
  roomId: string;
  scope: 'room-entry';
  subject: IntroductionSubject;
  issuer: IntroductionParty;
  issuedAt: number;
  expiresAt: number;
  nonce: string;
}

export interface IntroductionCredential extends UnsignedIntroductionCredential {
  signature: string;
}

export interface IntroductionChallenge {
  v: 'nintro-challenge1';
  roomId: string;
  verifierNodeId: string;
  challenge: string;
  expiresAt: number;
}

export interface IntroductionProof {
  v: 'nintro-proof1';
  credential: IntroductionCredential;
  verifierNodeId: string;
  challenge: string;
  challengeExpiresAt: number;
  signature: string;
}

export type IntroductionRejectReason =
  | 'unsupported-version'
  | 'malformed'
  | 'identity-mismatch'
  | 'issuer-not-member'
  | 'credential-expired'
  | 'proof-invalid'
  | 'replayed';

export type IntroductionValidation =
  | { ok: true }
  | { ok: false; reason: IntroductionRejectReason };

export interface IntroductionCredentialContext {
  roomId: string;
  subjectUid: string;
  subjectNodeId: string;
  participantUids: ReadonlySet<string>;
  now?: number;
  consumedNonces?: ReadonlySet<string>;
}

export interface IntroductionProofContext {
  challenge: IntroductionChallenge;
  now?: number;
  consumedChallenges?: ReadonlySet<string>;
}

function credentialCanonical(credential: UnsignedIntroductionCredential): string {
  return JSON.stringify([
    'NERILO-INTRODUCTION',
    'nintro1',
    credential.roomId,
    'room-entry',
    credential.subject.uid,
    credential.subject.nodeId,
    credential.subject.pubKey,
    credential.subject.ecdhPubKey,
    credential.issuer.uid,
    credential.issuer.nodeId,
    credential.issuer.pubKey,
    credential.issuedAt,
    credential.expiresAt,
    credential.nonce,
  ]);
}

function credentialFingerprintCanonical(credential: IntroductionCredential): string {
  const { signature, ...unsigned } = credential;
  return JSON.stringify([credentialCanonical(unsigned), signature]);
}

async function digest(data: string): Promise<ArrayBuffer> {
  return crypto.subtle.digest('SHA-256', new TextEncoder().encode(data));
}

async function importVerifyKey(pubKey: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'spki',
    base64ToArrayBuffer(pubKey),
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['verify']
  );
}

function isBoundedString(value: unknown, max = 2048): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= max;
}

function isNonce(value: unknown): value is string {
  return isBoundedString(value, 128) && /^[A-Za-z0-9_-]+$/.test(value) && value.length >= 22;
}

function hasCredentialShape(value: unknown): value is IntroductionCredential {
  if (!value || typeof value !== 'object') return false;
  const credential = value as Partial<IntroductionCredential>;
  const subject = credential.subject as Partial<IntroductionSubject> | undefined;
  const issuer = credential.issuer as Partial<IntroductionParty> | undefined;
  return credential.v === 'nintro1'
    && credential.scope === 'room-entry'
    && isBoundedString(credential.roomId, 128)
    && !!subject
    && isBoundedString(subject.uid, 256)
    && isBoundedString(subject.nodeId, 128)
    && isBoundedString(subject.pubKey)
    && isBoundedString(subject.ecdhPubKey)
    && !!issuer
    && isBoundedString(issuer.uid, 256)
    && isBoundedString(issuer.nodeId, 128)
    && isBoundedString(issuer.pubKey)
    && typeof credential.issuedAt === 'number'
    && Number.isSafeInteger(credential.issuedAt)
    && typeof credential.expiresAt === 'number'
    && Number.isSafeInteger(credential.expiresAt)
    && isNonce(credential.nonce)
    && isBoundedString(credential.signature);
}

export async function introductionNodeId(pubKey: string): Promise<string> {
  return (await sha256Hash(pubKey)).slice(0, 32);
}

export async function signIntroductionCredential(
  credential: UnsignedIntroductionCredential,
  issuerPrivateKey: CryptoKey
): Promise<IntroductionCredential> {
  const signature = await crypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' },
    issuerPrivateKey,
    await digest(credentialCanonical(credential))
  );
  return { ...credential, signature: arrayBufferToBase64(signature) };
}

export async function verifyIntroductionCredential(
  value: unknown,
  context: IntroductionCredentialContext
): Promise<IntroductionValidation> {
  if (!value || typeof value !== 'object') return { ok: false, reason: 'malformed' };
  if ((value as { v?: unknown }).v !== 'nintro1') return { ok: false, reason: 'unsupported-version' };
  if (!hasCredentialShape(value)) return { ok: false, reason: 'malformed' };
  const credential = value;
  const now = context.now ?? Date.now();

  if (credential.roomId !== context.roomId
    || credential.subject.uid !== context.subjectUid
    || credential.subject.nodeId !== context.subjectNodeId) {
    return { ok: false, reason: 'identity-mismatch' };
  }
  if (!context.participantUids.has(credential.issuer.uid)) {
    return { ok: false, reason: 'issuer-not-member' };
  }
  if (credential.expiresAt <= credential.issuedAt
    || credential.expiresAt - credential.issuedAt > INTRODUCTION_CREDENTIAL_MAX_AGE_MS
    || credential.issuedAt > now + INTRODUCTION_CLOCK_SKEW_MS
    || credential.expiresAt < now - INTRODUCTION_CLOCK_SKEW_MS) {
    return { ok: false, reason: 'credential-expired' };
  }
  if (context.consumedNonces?.has(credential.nonce)) {
    return { ok: false, reason: 'replayed' };
  }

  try {
    const [subjectNodeId, issuerNodeId] = await Promise.all([
      introductionNodeId(credential.subject.pubKey),
      introductionNodeId(credential.issuer.pubKey),
    ]);
    if (subjectNodeId !== credential.subject.nodeId || issuerNodeId !== credential.issuer.nodeId) {
      return { ok: false, reason: 'identity-mismatch' };
    }
    const key = await importVerifyKey(credential.issuer.pubKey);
    const { signature, ...unsigned } = credential;
    const valid = await crypto.subtle.verify(
      { name: 'ECDSA', hash: 'SHA-256' },
      key,
      base64ToArrayBuffer(signature),
      await digest(credentialCanonical(unsigned))
    );
    return valid ? { ok: true } : { ok: false, reason: 'proof-invalid' };
  } catch {
    return { ok: false, reason: 'proof-invalid' };
  }
}

function proofCanonical(
  credential: IntroductionCredential,
  challenge: IntroductionChallenge
): Promise<string> {
  return sha256Hash(credentialFingerprintCanonical(credential)).then((fingerprint) => JSON.stringify([
    'NERILO-INTRODUCTION-PROOF',
    'nintro-proof1',
    challenge.roomId,
    challenge.verifierNodeId,
    challenge.challenge,
    challenge.expiresAt,
    fingerprint,
  ]));
}

export async function signIntroductionProof(
  credential: IntroductionCredential,
  challenge: IntroductionChallenge,
  subjectPrivateKey: CryptoKey
): Promise<IntroductionProof> {
  const canonical = await proofCanonical(credential, challenge);
  const signature = await crypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' },
    subjectPrivateKey,
    await digest(canonical)
  );
  return {
    v: 'nintro-proof1',
    credential,
    verifierNodeId: challenge.verifierNodeId,
    challenge: challenge.challenge,
    challengeExpiresAt: challenge.expiresAt,
    signature: arrayBufferToBase64(signature),
  };
}

/**
 * 驗 subject 對指定 challenge 的持鑰證明。呼叫端仍須先以
 * verifyIntroductionCredential 驗過 issuer、房籍與憑證期限，不能只呼叫本函式。
 */
export async function verifyIntroductionProof(
  value: unknown,
  context: IntroductionProofContext
): Promise<IntroductionValidation> {
  if (!value || typeof value !== 'object') return { ok: false, reason: 'malformed' };
  const proof = value as Partial<IntroductionProof>;
  if (proof.v !== 'nintro-proof1') return { ok: false, reason: 'unsupported-version' };
  if (!hasCredentialShape(proof.credential)
    || !isBoundedString(proof.verifierNodeId, 128)
    || !isNonce(proof.challenge)
    || typeof proof.challengeExpiresAt !== 'number'
    || !Number.isSafeInteger(proof.challengeExpiresAt)
    || !isBoundedString(proof.signature)) {
    return { ok: false, reason: 'malformed' };
  }
  const now = context.now ?? Date.now();
  const expected = context.challenge;
  if (proof.credential.roomId !== expected.roomId
    || proof.verifierNodeId !== expected.verifierNodeId
    || proof.challenge !== expected.challenge
    || proof.challengeExpiresAt !== expected.expiresAt) {
    return { ok: false, reason: 'identity-mismatch' };
  }
  if (proof.challengeExpiresAt < now
    || proof.challengeExpiresAt - now > INTRODUCTION_CHALLENGE_MAX_AGE_MS) {
    return { ok: false, reason: 'credential-expired' };
  }
  if (context.consumedChallenges?.has(proof.challenge)) {
    return { ok: false, reason: 'replayed' };
  }

  try {
    const key = await importVerifyKey(proof.credential.subject.pubKey);
    const valid = await crypto.subtle.verify(
      { name: 'ECDSA', hash: 'SHA-256' },
      key,
      base64ToArrayBuffer(proof.signature),
      await digest(await proofCanonical(proof.credential, expected))
    );
    return valid ? { ok: true } : { ok: false, reason: 'proof-invalid' };
  } catch {
    return { ok: false, reason: 'proof-invalid' };
  }
}

/**
 * 本機驗證者的冪等入籍追蹤。相同房間、nonce 與 subject 重送視為同一結果；
 * nonce 被另一個 subject 使用才拒絕。這不提供跨驗證者收斂保證。
 */
export class LocalIntroductionAdmissionTracker {
  private readonly admitted = new Map<string, string>();

  admit(credential: IntroductionCredential): { ok: true; duplicate: boolean } | { ok: false } {
    const key = `${credential.roomId}\u0000${credential.nonce}`;
    const subject = `${credential.subject.uid}\u0000${credential.subject.nodeId}`;
    const existing = this.admitted.get(key);
    if (existing === subject) return { ok: true, duplicate: true };
    if (existing !== undefined) return { ok: false };
    this.admitted.set(key, subject);
    return { ok: true, duplicate: false };
  }
}
