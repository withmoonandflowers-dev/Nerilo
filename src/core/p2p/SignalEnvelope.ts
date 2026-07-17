/**
 * SignalEnvelope — peer 中繼 signaling 的加密信封（Spec 005 T1，p2p2p 自主連線）。
 *
 * 當已連上的 peer X 幫「發起方 from」把 WebRTC signaling（SDP offer/answer/ICE）
 * 中繼給「目標 to」時，X 是不可信管道。安全不靠 X 的善意：
 *
 *  - 機密性：SDP 對 to 的 ECDH 公鑰加密（ECDH→HKDF→AES-256-GCM），X 無 to 的私鑰 → 讀不到。
 *  - 完整性/來源：from 以身分金鑰（ECDSA）簽整個信封（含密文與 metadata），X 改任一 byte
 *    → 收端驗簽失敗 → 不建立錯誤連線（防惡意介紹人把你導去攻擊者）。
 *  - 域分離：HKDF info 專用於 signaling，與 keyx sender-key 分發不共用金鑰。
 *
 * 純函數、crypto 可注入（ECDH 金鑰為參數、ECDSA 簽/驗為函式）→ 可決定性單元/性質測試，
 * 零 I/O、零 firebase。承載與傳輸選擇是後續 task（T2/T3）；本檔只管「一則信封的封/拆」。
 */
import { deriveSharedSecret, encryptForPeer, decryptFromPeer } from '../crypto/ECDHKeyExchange';
import { arrayBufferToBase64, base64ToArrayBuffer } from '../../utils/crypto';

/** 簽章函式：用 from 的 ECDSA 私鑰簽 canonical 字串（Base64 簽章）。 */
export type SignFn = (data: string) => Promise<string>;
/** 驗證函式：用 from 的 ECDSA 公鑰驗 canonical 字串的簽章。 */
export type VerifyFn = (data: string, sig: string) => Promise<boolean>;

export type SignalKind = 'offer' | 'answer' | 'ice';

/** 加密 signaling 信封（線上格式；Protocol Spec 007 將固定此形狀）。 */
export interface SignalEnvelope {
  v: 'nsig1';
  from: string;   // 發起方 nodeId
  to: string;     // 目標 nodeId（X 依此轉發）
  room: string;   // 房間 id（供 X 路由 / 收端過濾）
  kind: SignalKind;
  epoch: number;  // ECDH 金鑰世代（收端據此選私鑰，向下相容輪替）
  ts: number;     // 毫秒時間戳（呼叫端注入，勿內部取現在時間）
  nonce: string;
  ct: string;     // 密文（Base64，對 to 的 ECDH 公鑰加密的 SDP/ICE）
  iv: string;     // Base64
  sig: string;    // from 的 ECDSA 簽章，覆蓋 canonical（含 ct/iv）
}

/** signaling 專用的 HKDF 域（與 keyx sender-key 分發區隔）。 */
const SIGNAL_DOMAIN = { salt: 'nerilo-signal-relay-v1', info: 'signal-relay-encryption' };

/** 決定性序列化：固定欄位順序，簽章覆蓋密文與全部 metadata。 */
function canonical(e: Omit<SignalEnvelope, 'sig'>): string {
  return JSON.stringify([e.v, e.from, e.to, e.room, e.kind, e.epoch, e.ts, e.nonce, e.ct, e.iv]);
}

/**
 * 封一則加密 signaling 信封。
 * @param payload  要傳的 SDP/ICE 明文字串
 * @param fromEcdhPrivate  發起方 ECDH 私鑰（協商共享密鑰）
 * @param toEcdhPublic     目標 ECDH 公鑰（協商共享密鑰）
 * @param sign             發起方 ECDSA 簽章函式（覆蓋密文，介紹人無法竄改）
 */
export async function sealSignal(
  params: {
    from: string; to: string; room: string; kind: SignalKind;
    epoch: number; ts: number; nonce: string; payload: string;
  },
  fromEcdhPrivate: CryptoKey,
  toEcdhPublic: CryptoKey,
  sign: SignFn
): Promise<SignalEnvelope> {
  if (params.from === params.to) throw new Error('SignalEnvelope: from 不可等於 to');
  const shared = await deriveSharedSecret(fromEcdhPrivate, toEcdhPublic, SIGNAL_DOMAIN);
  // TextEncoder 一定產非共享 ArrayBuffer；窄化以滿足 strict BufferSource 型別。
  const bytes = new TextEncoder().encode(params.payload);
  const { ciphertext, iv } = await encryptForPeer(bytes.buffer as ArrayBuffer, shared);
  const base: Omit<SignalEnvelope, 'sig'> = {
    v: 'nsig1',
    from: params.from, to: params.to, room: params.room, kind: params.kind,
    epoch: params.epoch, ts: params.ts, nonce: params.nonce,
    ct: arrayBufferToBase64(ciphertext),
    iv: arrayBufferToBase64(iv.buffer as ArrayBuffer),
  };
  const sig = await sign(canonical(base));
  return { ...base, sig };
}

/**
 * 拆一則信封：先驗簽（來源真實、未竄改）再解密。任一失敗即拋錯（收端不建立錯誤連線）。
 * @param expectedTo  本機 nodeId；信封 to 不符即拒（防轉錯對象）
 * @param toEcdhPrivate  本機 ECDH 私鑰
 * @param fromEcdhPublic 發起方 ECDH 公鑰（協商同一把共享密鑰）
 * @param verify         用發起方 ECDSA 公鑰驗簽
 */
export async function openSignal(
  env: SignalEnvelope,
  expectedTo: string,
  toEcdhPrivate: CryptoKey,
  fromEcdhPublic: CryptoKey,
  verify: VerifyFn
): Promise<{ from: string; room: string; kind: SignalKind; payload: string }> {
  if (env.v !== 'nsig1') throw new Error('SignalEnvelope: 未知版本');
  if (env.to !== expectedTo) throw new Error('SignalEnvelope: 收件對象不符');
  if (env.from === env.to) throw new Error('SignalEnvelope: from 不可等於 to');

  const { sig, ...rest } = env;
  const sigOk = await verify(canonical(rest), sig);
  if (!sigOk) throw new Error('SignalEnvelope: 簽章驗證失敗（來源不實或遭竄改）');

  const shared = await deriveSharedSecret(toEcdhPrivate, fromEcdhPublic, SIGNAL_DOMAIN);
  const pt = await decryptFromPeer(base64ToArrayBuffer(env.ct), new Uint8Array(base64ToArrayBuffer(env.iv)), shared);
  return { from: env.from, room: env.room, kind: env.kind, payload: new TextDecoder().decode(pt) };
}
