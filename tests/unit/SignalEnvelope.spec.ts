/**
 * SignalEnvelope 測試（Spec 005 T1）—— 加密 peer-relay signaling 信封。
 *
 * 用真實 WebCrypto ECDH(P-256) + ECDSA 跑，證明不只對 stub 有效：
 *  - 往返一致（unit + property：任意 SDP 字串封→拆還原）
 *  - 介紹人/第三方讀不到（異 ECDH 私鑰解不開）
 *  - 竄改必被抓（改密文或 metadata → 驗簽失敗）
 *  - 轉錯對象被拒、from===to 被拒
 *
 * @vitest-environment node
 */
import { describe, it, expect, beforeAll } from 'vitest';
import * as fc from 'fast-check';
import { sealSignal, openSignal, type SignalEnvelope } from '../../src/core/p2p/SignalEnvelope';
import { webCryptoSigner } from '../../src/core/incentive/CreditLedger';

function ecdh(): Promise<CryptoKeyPair> {
  return crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits', 'deriveKey']);
}
function ecdsa(): Promise<CryptoKeyPair> {
  return crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
}

// alice = 發起方 from；bob = 目標 to；eve = 介紹人/第三方（不該讀得到）
let aliceEcdh: CryptoKeyPair, bobEcdh: CryptoKeyPair, eveEcdh: CryptoKeyPair;
let aliceSig: ReturnType<typeof webCryptoSigner>;
let attackerSig: ReturnType<typeof webCryptoSigner>;

beforeAll(async () => {
  aliceEcdh = await ecdh();
  bobEcdh = await ecdh();
  eveEcdh = await ecdh();
  aliceSig = webCryptoSigner(await ecdsa());
  attackerSig = webCryptoSigner(await ecdsa());
});

const baseParams = (payload: string) => ({
  from: 'alice', to: 'bob', room: 'r1', kind: 'offer' as const,
  epoch: 0, ts: 1_700_000_000_000, nonce: 'n1', payload,
});

async function seal(payload: string): Promise<SignalEnvelope> {
  return sealSignal(baseParams(payload), aliceEcdh.privateKey, bobEcdh.publicKey, aliceSig.sign);
}

describe('SignalEnvelope — 往返', () => {
  it('bob 用自己的私鑰 + alice 公鑰 → 驗簽並解出原 SDP', async () => {
    const env = await seal('v=0\r\no=- offer sdp ...');
    const out = await openSignal(env, 'bob', bobEcdh.privateKey, aliceEcdh.publicKey, aliceSig.verify);
    expect(out).toEqual({ from: 'alice', room: 'r1', kind: 'offer', payload: 'v=0\r\no=- offer sdp ...' });
  });

  it('信封不含明文（ct 是密文，看不到 payload 片段）', async () => {
    const env = await seal('SECRET-CANDIDATE-192.168.1.5');
    expect(JSON.stringify(env)).not.toContain('SECRET-CANDIDATE');
    expect(JSON.stringify(env)).not.toContain('192.168.1.5');
  });

  it('property：任意 payload 封→拆還原', async () => {
    await fc.assert(
      fc.asyncProperty(fc.string(), async (payload) => {
        const env = await seal(payload);
        const out = await openSignal(env, 'bob', bobEcdh.privateKey, aliceEcdh.publicKey, aliceSig.verify);
        return out.payload === payload;
      }),
      { numRuns: 60 }
    );
  });
});

describe('SignalEnvelope — 介紹人/第三方讀不到', () => {
  it('eve（介紹人）用自己的 ECDH 私鑰解不開（AES-GCM 標籤失敗）', async () => {
    const env = await seal('v=0 sdp');
    await expect(
      openSignal(env, 'bob', eveEcdh.privateKey, aliceEcdh.publicKey, aliceSig.verify)
    ).rejects.toThrow(); // 導不出同一把共享密鑰 → 解密失敗
  });
});

describe('SignalEnvelope — 竄改必被抓', () => {
  it('改密文 ct → 驗簽失敗', async () => {
    const env = await seal('v=0 sdp');
    const tampered = { ...env, ct: Buffer.from('deadbeefdeadbeef').toString('base64') };
    await expect(
      openSignal(tampered, 'bob', bobEcdh.privateKey, aliceEcdh.publicKey, aliceSig.verify)
    ).rejects.toThrow(/簽章驗證失敗/);
  });

  it('改 metadata（把 to 換掉冒充）→ 驗簽失敗', async () => {
    const env = await seal('v=0 sdp');
    const tampered = { ...env, from: 'attacker' };
    await expect(
      openSignal(tampered, 'bob', bobEcdh.privateKey, aliceEcdh.publicKey, aliceSig.verify)
    ).rejects.toThrow(/簽章驗證失敗/);
  });

  it('用攻擊者的金鑰簽（偽造來源）→ 收端用 alice 公鑰驗，失敗', async () => {
    const forged = await sealSignal(baseParams('v=0 sdp'), aliceEcdh.privateKey, bobEcdh.publicKey, attackerSig.sign);
    await expect(
      openSignal(forged, 'bob', bobEcdh.privateKey, aliceEcdh.publicKey, aliceSig.verify)
    ).rejects.toThrow(/簽章驗證失敗/);
  });
});

describe('SignalEnvelope — 定址防護', () => {
  it('轉錯對象（expectedTo 不符）→ 拒', async () => {
    const env = await seal('v=0 sdp');
    await expect(
      openSignal(env, 'carol', bobEcdh.privateKey, aliceEcdh.publicKey, aliceSig.verify)
    ).rejects.toThrow(/收件對象不符/);
  });

  it('from === to → seal 拒', async () => {
    await expect(
      sealSignal({ ...baseParams('x'), from: 'same', to: 'same' }, aliceEcdh.privateKey, bobEcdh.publicKey, aliceSig.sign)
    ).rejects.toThrow(/不可等於/);
  });
});
