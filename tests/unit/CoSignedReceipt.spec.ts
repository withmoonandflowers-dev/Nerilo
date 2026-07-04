/**
 * CoSignedReceipt 測試（正當性層）
 *
 * 核心證明：relay 一方偽造不了——沒有 requester 共簽就驗不過。用真實 ECDSA。
 *
 * @vitest-environment node
 */
import { describe, it, expect } from 'vitest';
import {
  createReceiptDraft,
  counterSign,
  verifyReceipt,
  type SignFn,
  type VerifyFn,
} from '../../src/core/incentive/CoSignedReceipt';
import { webCryptoSigner } from '../../src/core/incentive/CreditLedger';

async function party(): Promise<{ sign: SignFn; verify: VerifyFn }> {
  const kp = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const signer = webCryptoSigner(kp);
  return { sign: (d) => signer.sign(d), verify: (d, s) => signer.verify(d, s) };
}

describe('CoSignedReceipt — 共簽正當性', () => {
  it('雙方共簽 → 驗證通過', async () => {
    const relay = await party();
    const requester = await party();

    const draft = await createReceiptDraft('A', 'B', 10240, 1, 'n1', relay.sign);
    const receipt = await counterSign(draft, requester.sign);

    expect(await verifyReceipt(receipt, relay.verify, requester.verify)).toBe(true);
  });

  it('只有 relay 簽、requester 簽是偽造的 → 驗證失敗（防單方偽造）', async () => {
    const relay = await party();
    const requester = await party();
    const attacker = await party();

    const draft = await createReceiptDraft('A', 'B', 10240, 1, 'n1', relay.sign);
    // A 想偽造 B 的共簽 → 只能用「別人的」金鑰簽，驗不過 requester 的公鑰
    const forged = await counterSign(draft, attacker.sign);

    expect(await verifyReceipt(forged, relay.verify, requester.verify)).toBe(false);
  });

  it('relay 簽是別人的 → 驗證失敗', async () => {
    const relay = await party();
    const requester = await party();
    const attacker = await party();

    const draft = await createReceiptDraft('A', 'B', 10240, 1, 'n1', attacker.sign); // 假冒 A 簽
    const receipt = await counterSign(draft, requester.sign);

    expect(await verifyReceipt(receipt, relay.verify, requester.verify)).toBe(false);
  });

  it('竄改 bytesRelayed → 驗證失敗（簽章覆蓋內容）', async () => {
    const relay = await party();
    const requester = await party();

    const draft = await createReceiptDraft('A', 'B', 10240, 1, 'n1', relay.sign);
    const receipt = await counterSign(draft, requester.sign);
    receipt.bytesRelayed = 999999; // 偷改賺更多

    expect(await verifyReceipt(receipt, relay.verify, requester.verify)).toBe(false);
  });

  it('自己簽給自己（relay === requester）→ 直接拒（女巫嫌疑）', async () => {
    const self = await party();
    const draft = await createReceiptDraft('A', 'A', 10240, 1, 'n1', self.sign);
    const receipt = await counterSign(draft, self.sign);

    expect(await verifyReceipt(receipt, self.verify, self.verify)).toBe(false);
  });

  it('bytesRelayed <= 0 起草即拒；驗證也拒', async () => {
    const relay = await party();
    const requester = await party();
    await expect(createReceiptDraft('A', 'B', 0, 1, 'n1', relay.sign)).rejects.toThrow();

    const draft = await createReceiptDraft('A', 'B', 10, 1, 'n1', relay.sign);
    const receipt = await counterSign(draft, requester.sign);
    receipt.bytesRelayed = 0;
    expect(await verifyReceipt(receipt, relay.verify, requester.verify)).toBe(false);
  });
});
