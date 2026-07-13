/**
 * CourierReceipts — 盲信使服務的可信計量原語（ADR-0022 「中繼即價值」Phase 2）
 *
 * 信使為成員代管密文＝提供服務，該賺點。但「自己宣稱幫忙」可偽造。ADR-0022 的解：
 * **交易對手共簽收據**——信使（relay，賺點方）起草並簽，成員（requester，受益方）回簽，
 * 兩簽都對同一份內容有效才算數。信使一個人偽造不了（沒有成員回簽不成立）。
 *
 * 本模組補上 CoSignedReceipt 缺的「具體 crypto」與「pubKey↔nodeId 綁定」：
 *  - ecdsaSigner/ecdsaVerifier：ECDSA P-256/SHA-256 對任意字串簽/驗（同 mesh 身分金鑰體系）。
 *  - assertPubKeyBindsNodeId：nodeId 必須 == hash(pubKey)，否則可冒名（拿別人 nodeId 配自己鑰匙）。
 *
 * 純函式、crypto 用 SubtleCrypto；收據交換的傳輸接線在 CourierService，計量落點在 CreditEconomy。
 */

import { arrayBufferToBase64, base64ToArrayBuffer } from '../../utils/crypto';
import { senderIdFromPubKey } from './TombstoneCrypto';
import { verifyReceipt, type CoSignedRelayReceipt, type SignFn, type VerifyFn } from '../incentive/CoSignedReceipt';

/** 用私鑰對任意字串簽 ECDSA（回 Base64）。給 CoSignedReceipt 的 SignFn。 */
export function ecdsaSigner(privateKey: CryptoKey): SignFn {
  return async (data: string) => {
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(data));
    const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, privateKey, digest);
    return arrayBufferToBase64(sig);
  };
}

/** 匯入公鑰、回一個驗字串簽章的 VerifyFn（金鑰只匯入一次）。 */
export async function ecdsaVerifier(pubKeyBase64: string): Promise<VerifyFn> {
  const key = await crypto.subtle.importKey(
    'spki',
    base64ToArrayBuffer(pubKeyBase64),
    { name: 'ECDSA', namedCurve: 'P-256' },
    true,
    ['verify']
  );
  return async (data: string, sig: string) => {
    try {
      const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(data));
      return await crypto.subtle.verify(
        { name: 'ECDSA', hash: 'SHA-256' },
        key,
        base64ToArrayBuffer(sig),
        digest
      );
    } catch {
      return false;
    }
  };
}

/** nodeId 必須是該 pubKey 導出的（否則冒名）。導法與 IdentityManager.deriveUserId 一致。 */
export async function pubKeyBindsNodeId(nodeId: string, pubKeyBase64: string): Promise<boolean> {
  return (await senderIdFromPubKey(pubKeyBase64)) === nodeId;
}

/**
 * 信使側最終驗收：共簽收據要通過三關才可據以賺點。
 *  1. relayPubKey ↔ receipt.relayNodeId（我＝賺點方，鑰匙對得上 nodeId）。
 *  2. requesterPubKey ↔ receipt.requesterNodeId（對方沒冒名）。
 *  3. 兩簽都對同一份收據內容有效（CoSignedReceipt.verifyReceipt，含 self-dealing 拒）。
 */
export async function verifyCoSignedReceipt(
  receipt: CoSignedRelayReceipt,
  relayPubKey: string,
  requesterPubKey: string
): Promise<boolean> {
  if (!(await pubKeyBindsNodeId(receipt.relayNodeId, relayPubKey))) return false;
  if (!(await pubKeyBindsNodeId(receipt.requesterNodeId, requesterPubKey))) return false;
  const relayVerify = await ecdsaVerifier(relayPubKey);
  const requesterVerify = await ecdsaVerifier(requesterPubKey);
  return verifyReceipt(receipt, relayVerify, requesterVerify);
}
