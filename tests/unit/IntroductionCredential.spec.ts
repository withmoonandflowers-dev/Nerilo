/**
 * Protocol Spec 030 的純協議簽驗。
 *
 * 這些案例只證明憑證、身分綁定與本機冪等，不代表產品已強制私有房入籍，
 * 也不代表 nonce 已在不同驗證者之間收斂。
 * @vitest-environment node
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { arrayBufferToBase64 } from '../../src/utils/crypto';
import {
  LocalIntroductionAdmissionTracker,
  introductionNodeId,
  signIntroductionCredential,
  signIntroductionProof,
  verifyIntroductionCredential,
  verifyIntroductionProof,
  type IntroductionChallenge,
  type IntroductionCredential,
  type UnsignedIntroductionCredential,
} from '../../src/core/p2p/IntroductionCredential';

const NOW = 1_788_566_400_000;
const NONCE = 'AAAAAAAAAAAAAAAAAAAAAA';
const CHALLENGE = 'BBBBBBBBBBBBBBBBBBBBBB';

let issuerKeys: CryptoKeyPair;
let subjectKeys: CryptoKeyPair;
let attackerKeys: CryptoKeyPair;
let subjectEcdhKeys: CryptoKeyPair;
let credential: IntroductionCredential;

async function keyPair(): Promise<CryptoKeyPair> {
  return crypto.subtle.generateKey(
    { name: 'ECDSA', namedCurve: 'P-256' },
    true,
    ['sign', 'verify']
  );
}

async function publicKey(key: CryptoKey): Promise<string> {
  return arrayBufferToBase64(await crypto.subtle.exportKey('spki', key));
}

beforeAll(async () => {
  [issuerKeys, subjectKeys, attackerKeys] = await Promise.all([keyPair(), keyPair(), keyPair()]);
  subjectEcdhKeys = await crypto.subtle.generateKey(
    { name: 'ECDH', namedCurve: 'P-256' },
    true,
    ['deriveBits', 'deriveKey']
  );
  const issuerPubKey = await publicKey(issuerKeys.publicKey);
  const subjectPubKey = await publicKey(subjectKeys.publicKey);
  const unsigned: UnsignedIntroductionCredential = {
    v: 'nintro1',
    roomId: 'room-1',
    scope: 'room-entry',
    subject: {
      uid: 'subject-uid',
      nodeId: await introductionNodeId(subjectPubKey),
      pubKey: subjectPubKey,
      ecdhPubKey: await publicKey(subjectEcdhKeys.publicKey),
    },
    issuer: {
      uid: 'member-uid',
      nodeId: await introductionNodeId(issuerPubKey),
      pubKey: issuerPubKey,
    },
    issuedAt: NOW,
    expiresAt: NOW + 300_000,
    nonce: NONCE,
  };
  credential = await signIntroductionCredential(unsigned, issuerKeys.privateKey);
});

const context = () => ({
  roomId: 'room-1',
  subjectUid: credential.subject.uid,
  subjectNodeId: credential.subject.nodeId,
  participantUids: new Set(['member-uid']),
  now: NOW + 1_000,
});

describe('IntroductionCredential', () => {
  it('目前在籍的成員可簽發 subject-bound 憑證', async () => {
    await expect(verifyIntroductionCredential(credential, context())).resolves.toEqual({ ok: true });
  });

  it('非房成員簽發者被拒', async () => {
    await expect(verifyIntroductionCredential(credential, {
      ...context(), participantUids: new Set(['someone-else']),
    })).resolves.toEqual({ ok: false, reason: 'issuer-not-member' });
  });

  it('改房間、subject 或簽章都被拒', async () => {
    await expect(verifyIntroductionCredential({ ...credential, roomId: 'room-2' }, context()))
      .resolves.toEqual({ ok: false, reason: 'identity-mismatch' });
    await expect(verifyIntroductionCredential({
      ...credential, subject: { ...credential.subject, uid: 'attacker' },
    }, context())).resolves.toEqual({ ok: false, reason: 'identity-mismatch' });
    await expect(verifyIntroductionCredential({ ...credential, signature: `${credential.signature}A` }, context()))
      .resolves.toEqual({ ok: false, reason: 'proof-invalid' });
  });

  it('改 issuer、期限、nonce 或 scope 不能沿用原簽章', async () => {
    const cases: unknown[] = [
      { ...credential, issuer: { ...credential.issuer, uid: 'other-member' } },
      { ...credential, expiresAt: credential.expiresAt - 1 },
      { ...credential, nonce: 'DDDDDDDDDDDDDDDDDDDDDD' },
      { ...credential, scope: 'chat-send' },
    ];
    for (const candidate of cases) {
      const candidateContext = {
        ...context(),
        participantUids: new Set(['member-uid', 'other-member']),
      };
      await expect(verifyIntroductionCredential(candidate, candidateContext))
        .resolves.not.toEqual({ ok: true });
    }
  });

  it('未知版本與缺欄位會 fail-closed', async () => {
    await expect(verifyIntroductionCredential({ ...credential, v: 'nintro2' }, context()))
      .resolves.toEqual({ ok: false, reason: 'unsupported-version' });
    await expect(verifyIntroductionCredential({ ...credential, nonce: undefined }, context()))
      .resolves.toEqual({ ok: false, reason: 'malformed' });
  });

  it('過期與已消耗 nonce 被拒', async () => {
    await expect(verifyIntroductionCredential(credential, {
      ...context(), now: NOW + 400_000,
    })).resolves.toEqual({ ok: false, reason: 'credential-expired' });
    await expect(verifyIntroductionCredential(credential, {
      ...context(), consumedNonces: new Set([NONCE]),
    })).resolves.toEqual({ ok: false, reason: 'replayed' });
  });

  it('subject 用自己的私鑰完成 challenge；冒名者失敗', async () => {
    const challenge: IntroductionChallenge = {
      v: 'nintro-challenge1',
      roomId: 'room-1',
      verifierNodeId: 'verifier-node',
      challenge: CHALLENGE,
      expiresAt: NOW + 30_000,
    };
    const proof = await signIntroductionProof(credential, challenge, subjectKeys.privateKey);
    await expect(verifyIntroductionProof(proof, {
      challenge, now: NOW + 1_000,
    })).resolves.toEqual({ ok: true });

    const forged = await signIntroductionProof(credential, challenge, attackerKeys.privateKey);
    await expect(verifyIntroductionProof(forged, {
      challenge, now: NOW + 1_000,
    })).resolves.toEqual({ ok: false, reason: 'proof-invalid' });

    await expect(verifyIntroductionProof(proof, {
      challenge: { ...challenge, challenge: 'CCCCCCCCCCCCCCCCCCCCCC' },
      now: NOW + 1_000,
    })).resolves.toEqual({ ok: false, reason: 'identity-mismatch' });

    await expect(verifyIntroductionProof(proof, {
      challenge,
      now: NOW + 1_000,
      consumedChallenges: new Set([CHALLENGE]),
    })).resolves.toEqual({ ok: false, reason: 'replayed' });

    await expect(verifyIntroductionProof(proof, {
      challenge: { ...challenge, roomId: 'another-room' },
      now: NOW + 1_000,
    })).resolves.toEqual({ ok: false, reason: 'identity-mismatch' });
  });

  it('相同 subject 重複入籍冪等，另一個 subject 重用 nonce 才拒絕', () => {
    const tracker = new LocalIntroductionAdmissionTracker();
    expect(tracker.admit(credential)).toEqual({ ok: true, duplicate: false });
    expect(tracker.admit(credential)).toEqual({ ok: true, duplicate: true });
    expect(tracker.admit({
      ...credential,
      subject: { ...credential.subject, uid: 'other-subject' },
    })).toEqual({ ok: false });
  });
});
