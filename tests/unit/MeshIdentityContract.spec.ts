/**
 * mesh 身分驗證契約——真 crypto 整合測試（無 mock）
 *
 * 補 QA 稽核缺口 1：mesh 單元把 SecurityManager/IdentityManager mock 掉，使收訊
 * 身分驗證的真實 crypto 路徑對單元隱形（extractable bug 因此漏掉、只有 E2E 抓到）。
 *
 * 這支用「真 ECDSA 金鑰 + 真 SecurityManager + 真 IdentityManager」跑
 * GossipMessageHandler.handleReceivedMessage 的身分驗證契約：
 *   簽名 → 匯入 pubKey → verifyMessage → deriveUserId(匯入的 key) === senderId
 * 任一環境（尤其 importPublicKey 的 extractable）破綻，這裡秒級就紅。
 *
 * @vitest-environment node
 */
import { describe, it, expect } from 'vitest';
import { SecurityManager } from '../../src/core/mesh/SecurityManager';
import { IdentityManager } from '../../src/core/mesh/IdentityManager';
import { arrayBufferToBase64 } from '../../src/utils/crypto';
import type { GossipMessage } from '../../src/types';

async function genKeyPair(): Promise<CryptoKeyPair> {
  return crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
}
async function spkiB64(key: CryptoKey): Promise<string> {
  return arrayBufferToBase64(await crypto.subtle.exportKey('spki', key));
}

describe('mesh 身分驗證契約（真 crypto，無 mock）', () => {
  const sm = new SecurityManager();
  const im = new IdentityManager();

  it('匯入的公鑰能被 deriveUserId（extractable 契約）——這支會抓 extractable:false', async () => {
    const kp = await genKeyPair();
    const senderUserId = await im.deriveUserId(kp.publicKey); // 送端自算

    // 收端：拿 base64 pubKey 匯入，再 deriveUserId（handleReceivedMessage 的實作）
    const imported = await sm.importPublicKey(await spkiB64(kp.publicKey));
    const derivedFromImported = await im.deriveUserId(imported); // extractable:false 時這裡 throw

    expect(derivedFromImported).toBe(senderUserId);
  });

  it('完整收訊契約：簽名 → 匯入 → 驗章 → senderId 一致', async () => {
    const kp = await genKeyPair();
    const senderId = await im.deriveUserId(kp.publicKey);

    const unsigned: Omit<GossipMessage, 'signature'> = {
      roomId: 'room-1',
      senderId,
      pubKey: await spkiB64(kp.publicKey),
      seq: 1,
      timestamp: Date.now(),
      content: 'hello mesh',
      ttl: 3,
    };
    const signature = await sm.signMessage(unsigned, kp.privateKey);
    const signed: GossipMessage = { ...unsigned, signature };

    // 收端全鏈
    const imported = await sm.importPublicKey(signed.pubKey);
    expect(await sm.verifyMessage(signed, imported)).toBe(true);
    expect(await im.deriveUserId(imported)).toBe(signed.senderId);
  });

  it('冒名：用別的金鑰簽但宣稱他人 senderId → deriveUserId 不符（防偽造）', async () => {
    const real = await genKeyPair();
    const attacker = await genKeyPair();
    const realId = await im.deriveUserId(real.publicKey);

    // 攻擊者用自己的 pubKey，卻宣稱 senderId 是 real 的
    const imported = await sm.importPublicKey(await spkiB64(attacker.publicKey));
    const derived = await im.deriveUserId(imported);

    expect(derived).not.toBe(realId); // handleReceivedMessage 會據此拒收
  });
});
