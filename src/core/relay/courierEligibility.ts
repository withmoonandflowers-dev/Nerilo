/**
 * 盲信使代管資格規則（Spec 012 P3；protocol 軌）
 *
 * 「盲信使只存密文」從描述升級為可驗證的協議規則。紀錄 r 為信使合格，若且唯若：
 *  1. r.channel === 'keyx' 且 content 可解析為 v:'keyx1' 的金鑰分發 payload
 *     （keyx 本身是成對 ECDH 封裝的密文集，且必須被信使保存——金鑰韌性＝資料韌性，
 *      ADR-0023 修訂三）；或
 *  2. 其餘 channel（含未標）之 content 為合法 nrec1 密文信封（isEncryptedContent 語義）。
 *
 * 明文紀錄（形成期明文窗、明文相容房）不合格：其補齊路徑只有成員間 anti-entropy，
 * 信使不代管（ADR-0023 修訂二硬前提：「紀錄仍為明文前，任何給非成員存＝洩露」）。
 * 推送側（runCourierBackup／CourierClient.reconcile）與收側（CourierStore.deposit／revive）
 * 皆執行本規則——推側堵洩漏，收側是防禦縱深與協議承諾。
 * conformance 向量見 tests/unit/CourierPlaintextFilter.spec.ts。
 */

import { isEncryptedContent } from '../mesh/RecordCrypto';
import type { GossipMessage } from '../../types';

/** 紀錄是否具信使代管資格（channel-aware：keyx 豁免 nrec1 要求，但須為合法 keyx1）。 */
export function isCourierEligibleRecord(msg: GossipMessage): boolean {
  if (msg.channel === 'keyx') {
    try {
      const p = JSON.parse(msg.content) as { v?: unknown; keys?: unknown };
      return p?.v === 'keyx1' && Array.isArray(p.keys);
    } catch {
      return false;
    }
  }
  return isEncryptedContent(msg.content);
}

/** 過濾出合格子集（推送側用：digest 與 push 皆不含明文紀錄）。 */
export function filterCourierEligible(records: GossipMessage[]): GossipMessage[] {
  return records.filter(isCourierEligibleRecord);
}
