/**
 * CreditLedger 測試（可驗證帳本）
 *
 * 重點：竄改任一環都要被 verify() 抓到——這是「防竄改」的證明。
 * 用真實 WebCrypto ECDSA 跑，證明不只對 stub 有效。
 * Spec 002（R5）：earn 必附 attestation；收據 fail-closed；attest 進雜湊鏈。
 *
 * @vitest-environment node
 */
import { describe, it, expect } from 'vitest';
import {
  CreditLedger,
  webCryptoSigner,
  type CreditEntry,
  type EarnAttestation,
} from '../../src/core/incentive/CreditLedger';
import { createReceiptDraft, counterSign } from '../../src/core/incentive/CoSignedReceipt';

async function genKey(): Promise<CryptoKeyPair> {
  return crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
}

/** 無交易對手情境（chain 機制測試）用白名單自證 */
const SELF: EarnAttestation = { kind: 'self', basis: 'grant' };

describe('CreditLedger — 雜湊鏈 + 餘額重放', () => {
  it('append + balance 由日誌重放', async () => {
    const l = new CreditLedger();
    await l.append('earn', 100, 'grant', 1, 'n1', SELF);
    await l.append('earn', 15, 'relay', 2, 'n2', SELF);
    await l.append('spend', 30, 'game:powerup', 3, 'n3');
    expect(l.balance()).toBe(85);
    expect(l.length).toBe(3);
  });

  it('乾淨鏈 verify() ok', async () => {
    const l = new CreditLedger();
    await l.append('earn', 100, 'grant', 1, 'n1', SELF);
    await l.append('spend', 10, 'x', 2, 'n2');
    expect(await l.verify()).toEqual({ ok: true });
  });

  it('拒絕負數 amount', async () => {
    const l = new CreditLedger();
    await expect(l.append('earn', -5, 'x', 1, 'n', SELF)).rejects.toThrow();
  });

  it('每筆 prevHash 串上一筆的 hash（genesis 為 0*64）', async () => {
    const l = new CreditLedger();
    const e0 = await l.append('earn', 1, 'a', 1, 'n1', SELF);
    const e1 = await l.append('earn', 1, 'b', 2, 'n2', SELF);
    expect(e0.prevHash).toBe('0'.repeat(64));
    expect(e1.prevHash).toBe(e0.hash);
  });
});

describe('CreditLedger — 竄改偵測（核心）', () => {
  async function build(): Promise<CreditLedger> {
    const l = new CreditLedger();
    await l.append('earn', 100, 'grant', 1, 'n1', SELF);
    await l.append('earn', 50, 'relay', 2, 'n2', SELF);
    await l.append('spend', 20, 'x', 3, 'n3');
    return l;
  }

  it('改金額 → verify 抓到 hash 不符', async () => {
    const l = await build();
    const tampered = l.getEntries();
    tampered[1]!.amount = 9999; // 偷偷把賺的點數改大
    const l2 = new CreditLedger();
    l2.load(JSON.stringify(tampered));
    const r = await l2.verify();
    expect(r.ok).toBe(false);
    expect(r.brokenAt).toBe(1);
    expect(r.reason).toBe('hash');
  });

  it('刪掉中間一筆 → prevHash 斷裂', async () => {
    const l = await build();
    const entries = l.getEntries();
    entries.splice(1, 1); // 刪第 2 筆
    // 重編 seq 讓 seq 檢查先過，凸顯 prevHash 斷裂
    entries.forEach((e, i) => (e.seq = i));
    const l2 = new CreditLedger();
    l2.load(JSON.stringify(entries));
    const r = await l2.verify();
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('prevHash');
  });

  it('插入偽造一筆 → 被抓', async () => {
    const l = await build();
    const entries = l.getEntries();
    const fake: CreditEntry = { seq: 3, prevHash: entries[2]!.hash, op: 'earn', amount: 1000, reason: 'fake', ts: 4, nonce: 'x', hash: 'deadbeef' };
    entries.push(fake);
    const l2 = new CreditLedger();
    l2.load(JSON.stringify(entries));
    const r = await l2.verify();
    expect(r.ok).toBe(false);
    expect(r.brokenAt).toBe(3);
    expect(r.reason).toBe('hash');
  });

  it('重排順序 → seq 不連續被抓', async () => {
    const l = await build();
    const entries = l.getEntries();
    [entries[0], entries[1]] = [entries[1]!, entries[0]!]; // 對調
    const l2 = new CreditLedger();
    l2.load(JSON.stringify(entries));
    const r = await l2.verify();
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('seq');
  });

  it('竄改 attest（改自證事由）→ 斷鏈被抓', async () => {
    const l = await build();
    const entries = l.getEntries();
    entries[0]!.attest = 'receipt:deadbeefdeadbeef'; // 假裝這筆有收據背書
    const l2 = new CreditLedger();
    l2.load(JSON.stringify(entries));
    const r = await l2.verify();
    expect(r.ok).toBe(false);
    expect(r.brokenAt).toBe(0);
    expect(r.reason).toBe('hash');
  });
});

describe('CreditLedger — earn 正當性強制（Spec 002 / R5）', () => {
  it('earn 無 attestation → 執行期 fail-closed 拒絕（繞過型別也擋）', async () => {
    const l = new CreditLedger();
    const sneaky = l.append as unknown as (
      op: string, amount: number, reason: string, ts: number, nonce: string
    ) => Promise<CreditEntry>;
    await expect(sneaky.call(l, 'earn', 100, 'hack', 1, 'n1')).rejects.toThrow(/必附 attestation/);
    expect(l.length).toBe(0); // 未入帳
  });

  it('自證事由不在白名單 → 拒絕', async () => {
    const l = new CreditLedger();
    const bad = { kind: 'self', basis: 'because-i-said-so' } as unknown as EarnAttestation;
    await expect(l.append('earn', 100, 'hack', 1, 'n1', bad)).rejects.toThrow(/白名單/);
    expect(l.length).toBe(0);
  });

  it('白名單自證 → 入帳且 attest 標注、鏈可驗', async () => {
    const l = new CreditLedger();
    const e = await l.append('earn', 5, 'uptime', 1, 'n1', { kind: 'self', basis: 'uptime' });
    expect(e.attest).toBe('self:uptime');
    expect(await l.verify()).toEqual({ ok: true });
  });

  it('有效共簽收據 → 入帳且 attest 帶收據摘要', async () => {
    const relay = webCryptoSigner(await genKey());
    const requester = webCryptoSigner(await genKey());
    const draft = await createReceiptDraft('relay-A', 'req-B', 1024, 10, 'nonce-1', relay.sign);
    const receipt = await counterSign(draft, requester.sign);

    const l = new CreditLedger();
    const e = await l.append('earn', 12, 'relay', 11, 'n1', {
      kind: 'receipt', receipt, relayVerify: relay.verify, requesterVerify: requester.verify,
    });
    expect(e.attest).toMatch(/^receipt:[0-9a-f]{16}$/);
    expect(await l.verify()).toEqual({ ok: true });
  });

  it('偽造收據（requester 簽章不對）→ 拒絕不入帳', async () => {
    const relay = webCryptoSigner(await genKey());
    const requester = webCryptoSigner(await genKey());
    const forger = webCryptoSigner(await genKey()); // 攻擊者自己湊的第二把鑰
    const draft = await createReceiptDraft('relay-A', 'req-B', 1024, 10, 'nonce-1', relay.sign);
    const forged = await counterSign(draft, forger.sign); // 沒有真 requester 的共簽

    const l = new CreditLedger();
    await expect(
      l.append('earn', 12, 'relay', 11, 'n1', {
        kind: 'receipt', receipt: forged, relayVerify: relay.verify, requesterVerify: requester.verify,
      })
    ).rejects.toThrow(/收據驗證失敗/);
    expect(l.length).toBe(0);
  });

  it('自己簽給自己（relay=requester）→ 拒絕', async () => {
    const me = webCryptoSigner(await genKey());
    const draft = await createReceiptDraft('me', 'other', 1024, 10, 'n', me.sign);
    const receipt = await counterSign(draft, me.sign);
    receipt.requesterNodeId = 'me'; // 女巫式自簽（驗證會因內容變動+同節點雙重被拒）

    const l = new CreditLedger();
    await expect(
      l.append('earn', 12, 'relay', 11, 'n1', {
        kind: 'receipt', receipt, relayVerify: me.verify, requesterVerify: me.verify,
      })
    ).rejects.toThrow(/收據驗證失敗/);
  });
});

describe('CreditLedger — 真實 ECDSA 簽章', () => {
  it('簽章 entry；驗章通過', async () => {
    const signer = webCryptoSigner(await genKey());
    const l = new CreditLedger(signer);
    const e = await l.append('earn', 100, 'grant', 1, 'n1', SELF);
    expect(e.sig).toBeTruthy();
    expect(await l.verify()).toEqual({ ok: true });
  });

  it('竄改被別把金鑰簽的假章 → 驗章失敗', async () => {
    const signer = webCryptoSigner(await genKey());
    const attacker = webCryptoSigner(await genKey());
    const l = new CreditLedger(signer);
    await l.append('earn', 100, 'grant', 1, 'n1', SELF);

    // 攻擊者想改金額，重算 hash，但只能用自己的金鑰簽 → 驗章用原 signer 會失敗
    const entries = l.getEntries();
    entries[0]!.amount = 9999;
    // 重算正確 hash 讓 hash 檢查過（攻擊者能算 SHA256）；canonical 含 attest
    const enc = new TextEncoder();
    const canon = JSON.stringify([entries[0]!.seq, entries[0]!.prevHash, 'earn', 9999, 'grant', 1, 'n1', 'self:grant']);
    entries[0]!.hash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(canon))))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
    entries[0]!.sig = await attacker.sign(entries[0]!.hash);

    const l2 = new CreditLedger(signer); // 用原擁有者金鑰驗
    l2.load(JSON.stringify(entries));
    const r = await l2.verify();
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('sig');
  });

  it('serialize/load round-trip 後仍 verify ok', async () => {
    const signer = webCryptoSigner(await genKey());
    const l = new CreditLedger(signer);
    await l.append('earn', 100, 'grant', 1, 'n1', SELF);
    await l.append('spend', 40, 'x', 2, 'n2');

    const l2 = new CreditLedger(signer);
    l2.load(l.serialize());
    expect(l2.balance()).toBe(60);
    expect(await l2.verify()).toEqual({ ok: true });
  });

  it('舊格式（無 attest 的持久化資料）載入後仍可驗（向後相容）', async () => {
    // 模擬 Spec 002 之前寫入的 entry：canonical 不含 attest
    const enc = new TextEncoder();
    const canon = JSON.stringify([0, '0'.repeat(64), 'earn', 100, 'grant', 1, 'n1']);
    const hash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(canon))))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
    const legacy: CreditEntry[] = [{ seq: 0, prevHash: '0'.repeat(64), op: 'earn', amount: 100, reason: 'grant', ts: 1, nonce: 'n1', hash }];
    const l = new CreditLedger();
    l.load(JSON.stringify(legacy));
    expect(await l.verify()).toEqual({ ok: true });
    expect(l.balance()).toBe(100);
  });
});
