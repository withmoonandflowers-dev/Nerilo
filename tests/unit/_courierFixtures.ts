/**
 * Courier 測試共用 fixture（Spec 012 P3）：信使協議自此只代管密文（keyx 豁免），
 * 測試紀錄的 content 一律用合法 nrec1 信封形狀（無需真加密——資格規則只驗形狀，
 * 真加解密由 RecordCrypto/GossipContentCrypto 測試覆蓋）。
 */
import type { GossipMessage } from '../../src/types';

/** 合法 nrec1 信封字串；tag 進 ct 欄，保留可讀性與唯一性。 */
export function enc(tag: string): string {
  return JSON.stringify({ v: 'nrec1', ct: tag, iv: 'aXYtdGVzdA==', ep: 0 });
}

/** 空信封的位元組數（encSized 的下限）。 */
const EMPTY = JSON.stringify({ v: 'nrec1', ct: '', iv: '', ep: 0 });
export const MIN_ENC_BYTES = EMPTY.length; // 36

/** 造出「恰好 nBytes」的合法信封 content（配額邊界測試用；n < 下限即拋）。 */
export function encSized(nBytes: number): string {
  const pad = nBytes - MIN_ENC_BYTES;
  if (pad < 0) throw new Error(`encSized: 至少 ${MIN_ENC_BYTES} bytes（要求 ${nBytes}）`);
  return JSON.stringify({ v: 'nrec1', ct: 'x'.repeat(pad), iv: '', ep: 0 });
}

/** 合法 keyx 紀錄 content（信使豁免通道）。 */
export function keyxContent(): string {
  return JSON.stringify({ v: 'keyx1', producerEcdh: 'spki-b64', keys: [] });
}

/** 便利：把一筆紀錄 content 換成合法密文信封。 */
export function encRecord(base: GossipMessage, tag: string): GossipMessage {
  return { ...base, content: enc(tag) };
}
