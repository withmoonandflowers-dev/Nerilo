/**
 * CreditLedger — 可驗證的點數帳本（簽章收據 + 雜湊鏈，ADR-0022）
 *
 * 給點數帳本「正確性/防竄改」，成本接近零——不用區塊鏈、gas、錢包、代幣：
 *
 *  1. 雜湊鏈：每筆異動 hash = SHA256(prevHash + entry)。插入/刪除/竄改任一筆，
 *     其後全部對不上 → verify() 立刻抓出斷點。
 *  2. 簽章收據：每筆用身分金鑰（ECDSA）簽 entry hash（signer 可注入）。
 *     證明是誰授權的、可稽核。第三方無法偽造他人的 entry。
 *  3. 餘額 = 重放：balance() 是把日誌加總算出來，不是獨立存的數字——
 *     所以「餘額正確」等價於「日誌完整」，一次 verify 全保證。
 *
 * 誠實邊界：自簽的自有日誌能防「第三方竄改」與「事後偷改」（鏈斷），但擋不了
 *  擁有金鑰的本人重寫整條並重簽。要防本人偽造「賺點」，需交易對手『共簽收據』
 *  （earn 事件由 requester 一起簽，見 RelayReceipt 的雙簽）。
 *
 * 正當性強制（Spec 002，收斂稽核 R5）：earn 型 append 在型別層必附 attestation——
 *  'receipt'（共簽收據，入帳前 verifyReceipt fail-closed）或 'self'（無交易對手的
 *  自證事由白名單：uptime/grant，明白標注供稽核）。attestation 摘要寫入 entry 並
 *  納入雜湊鏈，事後不可抵賴。驗證函式不落盤，故 verify() 只保完整性；收據有效性
 *  在入帳當下 fail-closed 把關。
 *
 * 純核心、crypto 可注入（可測、框架無關）。
 */

import { verifyReceipt, type CoSignedRelayReceipt, type VerifyFn } from './CoSignedReceipt';

export type CreditOp = 'earn' | 'spend';

/** 無交易對手、允許自證的賺點事由白名單（在線累積、初始配額）。 */
export type SelfEarnBasis = 'uptime' | 'grant';

/** earn 的正當性證明：共簽收據（可驗）或白名單自證（明白標注）。 */
export type EarnAttestation =
  | {
      kind: 'receipt';
      receipt: CoSignedRelayReceipt;
      /** 用賺點方（relay）公鑰驗其半簽 */
      relayVerify: VerifyFn;
      /** 用受益方（requester）公鑰驗其共簽 */
      requesterVerify: VerifyFn;
    }
  | { kind: 'self'; basis: SelfEarnBasis };

export interface CreditEntry {
  /** 序號，從 0 起單調遞增 */
  seq: number;
  /** 前一筆的 hash（genesis 為 64 個 0） */
  prevHash: string;
  op: CreditOp;
  amount: number;
  /** 事由（如 'relay' / 'uptime' / 'game:powerup'） */
  reason: string;
  ts: number;
  /** 防重放/碰撞的隨機值 */
  nonce: string;
  /**
   * 正當性摘要（earn 必有；spend 與舊資料省略）：
   * 'receipt:<sha256 前 16 hex>'（共簽收據，入帳時已 fail-closed 驗證）或 'self:<basis>'。
   * 有值時納入 canonical → 進雜湊鏈，事後竄改 attest 即斷鏈。
   */
  attest?: string;
  /** SHA256(canonical(seq,prevHash,op,amount,reason,ts,nonce[,attest])) hex */
  hash: string;
  /** 擁有者對 hash 的簽章（base64；無 signer 時省略） */
  sig?: string;
}

/** 可注入的簽章器（production 用身分金鑰；測試可用 stub） */
export interface LedgerSigner {
  sign(data: string): Promise<string>;
  verify(data: string, sig: string): Promise<boolean>;
}

export interface VerifyResult {
  ok: boolean;
  /** 第一個出問題的 index（ok 時省略） */
  brokenAt?: number;
  /** 'seq' | 'prevHash' | 'hash' | 'sig' */
  reason?: string;
}

const GENESIS_HASH = '0'.repeat(64);

/** SHA-256 hex（Web Crypto，node + 瀏覽器皆可） */
async function sha256Hex(input: string): Promise<string> {
  const bytes = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * 決定性序列化：陣列固定順序，JSON 轉義 reason 中的特殊字元。
 * attest 有值才附加——舊持久化資料（無 attest）的既有 hash 維持可驗（向後相容）。
 */
function canonical(e: Omit<CreditEntry, 'hash' | 'sig'>): string {
  const base: unknown[] = [e.seq, e.prevHash, e.op, e.amount, e.reason, e.ts, e.nonce];
  if (e.attest !== undefined) base.push(e.attest);
  return JSON.stringify(base);
}

/** 收據摘要（attest 用）：對收據決定性內容（含雙簽）取 SHA256 前 16 hex。 */
async function receiptRef(r: CoSignedRelayReceipt): Promise<string> {
  const canon = JSON.stringify([r.relayNodeId, r.requesterNodeId, r.bytesRelayed, r.ts, r.nonce, r.relaySig, r.requesterSig]);
  return (await sha256Hex(canon)).slice(0, 16);
}

const SELF_EARN_BASES: ReadonlySet<string> = new Set(['uptime', 'grant'] satisfies SelfEarnBasis[]);

export class CreditLedger {
  private entries: CreditEntry[] = [];
  /** append 序列化佇列：雜湊鏈要求嚴格順序，並行 append 會撞同一 prevHash 斷鏈 */
  private tail: Promise<unknown> = Promise.resolve();

  constructor(private readonly signer?: LedgerSigner) {}

  /**
   * 附加一筆異動（自動串鏈、簽章）。並行呼叫會自動序列化。回傳新 entry。
   * earn 型別層必附 attestation（Spec 002 / R5）：收據入帳前 fail-closed 驗證，
   * 自證僅限白名單事由。spend 不需（花錢不需要證明正當性，餘額檢查在上游）。
   */
  append(op: 'spend', amount: number, reason: string, ts: number, nonce: string): Promise<CreditEntry>;
  append(op: 'earn', amount: number, reason: string, ts: number, nonce: string, attestation: EarnAttestation): Promise<CreditEntry>;
  append(op: CreditOp, amount: number, reason: string, ts: number, nonce: string, attestation?: EarnAttestation): Promise<CreditEntry> {
    const result = this.tail.then(() => this.appendInternal(op, amount, reason, ts, nonce, attestation));
    // 佇列不因單筆失敗而中斷後續
    this.tail = result.catch(() => undefined);
    return result;
  }

  private async appendInternal(
    op: CreditOp,
    amount: number,
    reason: string,
    ts: number,
    nonce: string,
    attestation?: EarnAttestation
  ): Promise<CreditEntry> {
    if (amount < 0 || !Number.isFinite(amount)) {
      throw new RangeError('CreditLedger amount 需非負有限數');
    }
    // 執行期 fail-closed：型別繞得過（JS 呼叫端/as any），這裡繞不過
    let attest: string | undefined;
    if (op === 'earn') {
      if (!attestation) throw new Error('CreditLedger earn 必附 attestation（收據或白名單自證）');
      if (attestation.kind === 'receipt') {
        const ok = await verifyReceipt(attestation.receipt, attestation.relayVerify, attestation.requesterVerify);
        if (!ok) throw new Error('CreditLedger 收據驗證失敗，拒絕入帳');
        attest = `receipt:${await receiptRef(attestation.receipt)}`;
      } else {
        if (!SELF_EARN_BASES.has(attestation.basis)) {
          throw new Error(`CreditLedger 自證事由不在白名單: ${attestation.basis}`);
        }
        attest = `self:${attestation.basis}`;
      }
    }
    const prevHash = this.entries.length > 0 ? this.entries[this.entries.length - 1]!.hash : GENESIS_HASH;
    const seq = this.entries.length;
    const base = { seq, prevHash, op, amount, reason, ts, nonce, ...(attest !== undefined ? { attest } : {}) };
    const hash = await sha256Hex(canonical(base));
    const sig = this.signer ? await this.signer.sign(hash) : undefined;
    const entry: CreditEntry = { ...base, hash, ...(sig ? { sig } : {}) };
    this.entries.push(entry);
    return entry;
  }

  /** 等佇列中所有 append 完成（verify/export/balance 前確保寫入落定） */
  async settled(): Promise<void> {
    await this.tail;
  }

  /** 餘額 = 重放日誌（earn 加、spend 減） */
  balance(): number {
    return this.entries.reduce((b, e) => b + (e.op === 'earn' ? e.amount : -e.amount), 0);
  }

  getEntries(): CreditEntry[] {
    return this.entries.map((e) => ({ ...e }));
  }

  get length(): number {
    return this.entries.length;
  }

  /**
   * 驗證整條鏈：序號連續、prevHash 相接、hash 正確、（若有 signer）簽章有效。
   * 任一環斷裂即回報第一個斷點。這是「防竄改」的核心。
   */
  async verify(): Promise<VerifyResult> {
    let prev = GENESIS_HASH;
    for (let i = 0; i < this.entries.length; i++) {
      const e = this.entries[i]!;
      if (e.seq !== i) return { ok: false, brokenAt: i, reason: 'seq' };
      if (e.prevHash !== prev) return { ok: false, brokenAt: i, reason: 'prevHash' };
      const expected = await sha256Hex(
        canonical({
          seq: e.seq, prevHash: e.prevHash, op: e.op, amount: e.amount,
          reason: e.reason, ts: e.ts, nonce: e.nonce,
          ...(e.attest !== undefined ? { attest: e.attest } : {}),
        })
      );
      if (expected !== e.hash) return { ok: false, brokenAt: i, reason: 'hash' };
      if (this.signer && e.sig !== undefined) {
        const sigOk = await this.signer.verify(e.hash, e.sig);
        if (!sigOk) return { ok: false, brokenAt: i, reason: 'sig' };
      }
      prev = e.hash;
    }
    return { ok: true };
  }

  /** 匯出（持久化/傳輸） */
  serialize(): string {
    return JSON.stringify(this.entries);
  }

  /** 載入（不驗證；載入後應呼叫 verify()） */
  load(json: string): void {
    const parsed = JSON.parse(json) as CreditEntry[];
    this.entries = Array.isArray(parsed) ? parsed : [];
  }
}

/**
 * WebCrypto ECDSA(P-256) 簽章器——production 用（餵身分金鑰對）。
 * 測試也可用它跑真實 crypto，證明不只對 stub 有效。
 */
export function webCryptoSigner(keyPair: CryptoKeyPair): LedgerSigner {
  const enc = new TextEncoder();
  const toB64 = (buf: ArrayBuffer) => btoa(String.fromCharCode(...new Uint8Array(buf)));
  const fromB64 = (b64: string) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  return {
    async sign(data) {
      const sig = await crypto.subtle.sign(
        { name: 'ECDSA', hash: 'SHA-256' },
        keyPair.privateKey,
        enc.encode(data)
      );
      return toB64(sig);
    },
    async verify(data, sig) {
      return crypto.subtle.verify(
        { name: 'ECDSA', hash: 'SHA-256' },
        keyPair.publicKey,
        fromB64(sig),
        enc.encode(data)
      );
    },
  };
}
