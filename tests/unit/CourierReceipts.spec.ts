/**
 * CourierReceipts 測試（ADR-0022 計量原語，真 ECDSA 金鑰）
 *  - ecdsaSigner/ecdsaVerifier：簽→驗來回；換鑰匙驗不過。
 *  - pubKeyBindsNodeId：nodeId 必須是 pubKey 導出的。
 *  - verifyCoSignedReceipt：雙 pubKey 綁定 + 雙簽有效才過；冒名/自簽自/竄改拒。
 *
 * @vitest-environment node
 */
import { describe, it, expect } from 'vitest';
import {
  ecdsaSigner,
  ecdsaVerifier,
  pubKeyBindsNodeId,
  verifyCoSignedReceipt,
} from '../../src/core/relay/CourierReceipts';
import { createReceiptDraft, counterSign } from '../../src/core/incentive/CoSignedReceipt';
import { senderIdFromPubKey } from '../../src/core/relay/TombstoneCrypto';
import { arrayBufferToBase64 } from '../../src/utils/crypto';

async function makeNode() {
  const kp = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const pubKey = arrayBufferToBase64(await crypto.subtle.exportKey('spki', kp.publicKey));
  const nodeId = await senderIdFromPubKey(pubKey);
  return { pubKey, nodeId, sign: ecdsaSigner(kp.privateKey) };
}

/** 造一張完整共簽收據（relay 起草簽 + requester 回簽）。 */
async function coSign(relay: Awaited<ReturnType<typeof makeNode>>, requester: Awaited<ReturnType<typeof makeNode>>, bytes: number) {
  const draft = await createReceiptDraft(relay.nodeId, requester.nodeId, bytes, 1000, 'n1', relay.sign);
  return counterSign(draft, requester.sign);
}

describe('CourierReceipts — ecdsa 字串簽/驗', () => {
  it('簽→驗來回；換鑰匙驗不過', async () => {
    const a = await makeNode();
    const b = await makeNode();
    const sig = await a.sign('hello');
    expect(await (await ecdsaVerifier(a.pubKey))('hello', sig)).toBe(true);
    expect(await (await ecdsaVerifier(b.pubKey))('hello', sig)).toBe(false);
    expect(await (await ecdsaVerifier(a.pubKey))('tampered', sig)).toBe(false);
  });
});

describe('CourierReceipts — pubKeyBindsNodeId', () => {
  it('nodeId == hash(pubKey) → true；不符 → false', async () => {
    const a = await makeNode();
    expect(await pubKeyBindsNodeId(a.nodeId, a.pubKey)).toBe(true);
    expect(await pubKeyBindsNodeId('not-my-id', a.pubKey)).toBe(false);
  });
});

describe('CourierReceipts — verifyCoSignedReceipt', () => {
  it('合法雙簽 + 雙 pubKey 綁定 → true', async () => {
    const relay = await makeNode();
    const requester = await makeNode();
    const receipt = await coSign(relay, requester, 500);
    expect(await verifyCoSignedReceipt(receipt, relay.pubKey, requester.pubKey)).toBe(true);
  });

  it('relay 冒名（pubKey 與 relayNodeId 不符）→ false', async () => {
    const relay = await makeNode();
    const requester = await makeNode();
    const imposter = await makeNode();
    const receipt = await coSign(relay, requester, 500);
    // 用冒名者的 pubKey 配 relayNodeId → 綁定關卡擋下。
    expect(await verifyCoSignedReceipt(receipt, imposter.pubKey, requester.pubKey)).toBe(false);
  });

  it('requester 半簽是別人簽的（pubKey 對得上 nodeId 但簽章不符）→ false', async () => {
    const relay = await makeNode();
    const requester = await makeNode();
    const mallory = await makeNode();
    const draft = await createReceiptDraft(relay.nodeId, requester.nodeId, 500, 1000, 'n1', relay.sign);
    // mallory 回簽（但收據裡 requesterNodeId 是 requester）→ 用 requester.pubKey 驗 mallory 的簽 → 敗。
    const forged = await counterSign(draft, mallory.sign);
    expect(await verifyCoSignedReceipt(forged, relay.pubKey, requester.pubKey)).toBe(false);
  });

  it('自簽自（relayNodeId == requesterNodeId）→ false（女巫）', async () => {
    const solo = await makeNode();
    const draft = await createReceiptDraft(solo.nodeId, solo.nodeId, 500, 1000, 'n1', solo.sign);
    const receipt = await counterSign(draft, solo.sign);
    expect(await verifyCoSignedReceipt(receipt, solo.pubKey, solo.pubKey)).toBe(false);
  });
});
