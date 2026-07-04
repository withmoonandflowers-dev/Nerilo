/**
 * CoSignedReceipt — 共簽中繼收據（正當性層，ADR-0022 續）
 *
 * 補上帳本（CreditLedger）缺的那一半：帳本保證「記錄沒被竄改」（完整性），
 * 但擋不了「本人偽造賺點」——A 自己宣稱「我幫 B 中繼了 N bytes」就想賺點。
 *
 * 解法：**交易對手共簽**。收據要「賺點的一方（relay=A）」與「受益的一方
 * （requester=B）」都簽才有效。A 一個人偽造不了——沒有 B 的簽章就不算數。
 * 配合防女巫（App Check + 非匿名 auth 讓 B 是真帳號），賺點就非偽造：
 *
 *   完整性（帳本雜湊鏈）+ 正當性（共簽收據）+ 唯一性（防女巫）= 可信點數
 *
 * 純核心、crypto 可注入。實際協議（中繼當下 B 即時回簽）是傳輸層 wiring，留部署；
 * 本模組負責「收據的產生與驗證邏輯」，可獨立測試。
 */

/** 驗證函式：用某方的公鑰驗 data 的簽章 */
export type VerifyFn = (data: string, sig: string) => Promise<boolean>;
/** 簽章函式：用某方的私鑰簽 data */
export type SignFn = (data: string) => Promise<string>;

/** relay 起草、尚未共簽的收據 */
export interface ReceiptDraft {
  relayNodeId: string;
  requesterNodeId: string;
  bytesRelayed: number;
  ts: number;
  nonce: string;
  /** relay（賺點方）對收據內容的簽章 */
  relaySig: string;
}

/** 雙方共簽、可據以賺點的收據 */
export interface CoSignedRelayReceipt extends ReceiptDraft {
  /** requester（受益方）的共簽——正當性的關鍵 */
  requesterSig: string;
}

/** 決定性序列化：固定欄位順序，JSON 轉義 */
function canonical(r: {
  relayNodeId: string;
  requesterNodeId: string;
  bytesRelayed: number;
  ts: number;
  nonce: string;
}): string {
  return JSON.stringify([r.relayNodeId, r.requesterNodeId, r.bytesRelayed, r.ts, r.nonce]);
}

/**
 * relay 方起草收據並簽名（賺點方先聲明「我幫 requester 轉了 N bytes」）。
 */
export async function createReceiptDraft(
  relayNodeId: string,
  requesterNodeId: string,
  bytesRelayed: number,
  ts: number,
  nonce: string,
  relaySign: SignFn
): Promise<ReceiptDraft> {
  if (bytesRelayed <= 0) throw new RangeError('bytesRelayed 需 > 0');
  const relaySig = await relaySign(canonical({ relayNodeId, requesterNodeId, bytesRelayed, ts, nonce }));
  return { relayNodeId, requesterNodeId, bytesRelayed, ts, nonce, relaySig };
}

/**
 * requester 方共簽（受益方確認「對，A 確實幫我轉了」）。
 * 這一步讓 relay 無法單方偽造——沒有 requester 的簽章收據不成立。
 */
export async function counterSign(
  draft: ReceiptDraft,
  requesterSign: SignFn
): Promise<CoSignedRelayReceipt> {
  const requesterSig = await requesterSign(
    canonical({
      relayNodeId: draft.relayNodeId,
      requesterNodeId: draft.requesterNodeId,
      bytesRelayed: draft.bytesRelayed,
      ts: draft.ts,
      nonce: draft.nonce,
    })
  );
  return { ...draft, requesterSig };
}

/**
 * 驗證共簽收據：relaySig 用 relay 公鑰、requesterSig 用 requester 公鑰，
 * 兩者都要對同一份收據內容有效。任一方缺/錯即不正當。
 */
export async function verifyReceipt(
  receipt: CoSignedRelayReceipt,
  relayVerify: VerifyFn,
  requesterVerify: VerifyFn
): Promise<boolean> {
  if (receipt.bytesRelayed <= 0) return false;
  if (receipt.relayNodeId === receipt.requesterNodeId) return false; // 自己簽給自己 → 女巫嫌疑，拒
  const data = canonical({
    relayNodeId: receipt.relayNodeId,
    requesterNodeId: receipt.requesterNodeId,
    bytesRelayed: receipt.bytesRelayed,
    ts: receipt.ts,
    nonce: receipt.nonce,
  });
  const [relayOk, requesterOk] = await Promise.all([
    relayVerify(data, receipt.relaySig),
    requesterVerify(data, receipt.requesterSig),
  ]);
  return relayOk && requesterOk;
}
