/**
 * CreditLedger 測試（可驗證帳本）
 *
 * 重點：竄改任一環都要被 verify() 抓到——這是「防竄改」的證明。
 * 用真實 WebCrypto ECDSA 跑，證明不只對 stub 有效。
 *
 * @vitest-environment node
 */
import { describe, it, expect } from 'vitest';
import { CreditLedger, webCryptoSigner, type CreditEntry } from '../../src/core/incentive/CreditLedger';

async function genKey(): Promise<CryptoKeyPair> {
  return crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
}

describe('CreditLedger — 雜湊鏈 + 餘額重放', () => {
  it('append + balance 由日誌重放', async () => {
    const l = new CreditLedger();
    await l.append('earn', 100, 'grant', 1, 'n1');
    await l.append('earn', 15, 'relay', 2, 'n2');
    await l.append('spend', 30, 'game:powerup', 3, 'n3');
    expect(l.balance()).toBe(85);
    expect(l.length).toBe(3);
  });

  it('乾淨鏈 verify() ok', async () => {
    const l = new CreditLedger();
    await l.append('earn', 100, 'grant', 1, 'n1');
    await l.append('spend', 10, 'x', 2, 'n2');
    expect(await l.verify()).toEqual({ ok: true });
  });

  it('拒絕負數 amount', async () => {
    const l = new CreditLedger();
    await expect(l.append('earn', -5, 'x', 1, 'n')).rejects.toThrow();
  });

  it('每筆 prevHash 串上一筆的 hash（genesis 為 0*64）', async () => {
    const l = new CreditLedger();
    const e0 = await l.append('earn', 1, 'a', 1, 'n1');
    const e1 = await l.append('earn', 1, 'b', 2, 'n2');
    expect(e0.prevHash).toBe('0'.repeat(64));
    expect(e1.prevHash).toBe(e0.hash);
  });
});

describe('CreditLedger — 竄改偵測（核心）', () => {
  async function build(): Promise<CreditLedger> {
    const l = new CreditLedger();
    await l.append('earn', 100, 'grant', 1, 'n1');
    await l.append('earn', 50, 'relay', 2, 'n2');
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
});

describe('CreditLedger — 真實 ECDSA 簽章', () => {
  it('簽章 entry；驗章通過', async () => {
    const signer = webCryptoSigner(await genKey());
    const l = new CreditLedger(signer);
    const e = await l.append('earn', 100, 'grant', 1, 'n1');
    expect(e.sig).toBeTruthy();
    expect(await l.verify()).toEqual({ ok: true });
  });

  it('竄改被別把金鑰簽的假章 → 驗章失敗', async () => {
    const signer = webCryptoSigner(await genKey());
    const attacker = webCryptoSigner(await genKey());
    const l = new CreditLedger(signer);
    await l.append('earn', 100, 'grant', 1, 'n1');

    // 攻擊者想改金額，重算 hash，但只能用自己的金鑰簽 → 驗章用原 signer 會失敗
    const entries = l.getEntries();
    entries[0]!.amount = 9999;
    // 重算正確 hash 讓 hash 檢查過（攻擊者能算 SHA256），但簽章是攻擊者的
    const enc = new TextEncoder();
    const canon = JSON.stringify([entries[0]!.seq, entries[0]!.prevHash, 'earn', 9999, 'grant', 1, 'n1']);
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
    await l.append('earn', 100, 'grant', 1, 'n1');
    await l.append('spend', 40, 'x', 2, 'n2');

    const l2 = new CreditLedger(signer);
    l2.load(l.serialize());
    expect(l2.balance()).toBe(60);
    expect(await l2.verify()).toEqual({ ok: true });
  });
});
