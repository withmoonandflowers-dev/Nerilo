/**
 * Raw 通道二進位密封（Spec 023 T1）。
 *
 * 語義（Q1 拍板：強制房間金鑰）：
 *  - 密封一律用「現行送出金鑰」；金鑰未就緒 → 回 null（呼叫端丟棄＋計數，不排隊、不退明文）。
 *  - 開封按 frame 內的 epoch 選鑰；環中無該代金鑰 → 拋錯（呼叫端丟棄＋計數）。
 *  - 不去重、不補送、不保序——DataChannel 原生語義直通，可靠性由嵌入者的應用層自理。
 *
 * 線上格式 raw-v1（新格式，回填協議文件）：
 *   [0] ver = 0x01
 *   [1] flags：bit0 = payload 是 UTF-8 字串（0 = 二進位）
 *   [2..5] epoch（uint32 big-endian）
 *   [6..17] AES-GCM IV（12 bytes）
 *   [18..] ciphertext（含 GCM tag）
 * 不用 JSON/base64：nrec1 字串信封對 150 bytes 級、60Hz 的封包是純浪費。
 *
 * 純邏輯模組：金鑰經 port 注入（RoomContentKeyRing 的兩個唯讀 getter），零 I/O、可直測。
 */

export interface RawKeyPort {
  /** 現行送出金鑰與 epoch；null = 未就緒。 */
  getSendKeyWithEpoch(): { key: CryptoKey; epoch: number } | null;
  /** 指定 epoch 的金鑰；undefined = 環中沒有（未在籍或尚未補齊）。 */
  getKeyForEpoch(epoch: number): CryptoKey | undefined;
}

export type RawPayload = Uint8Array | string;

const VER = 0x01;
const FLAG_STRING = 0b0000_0001;
const HEADER_LEN = 18; // ver(1) + flags(1) + epoch(4) + iv(12)

/**
 * 密封。金鑰未就緒回 null——呼叫端據此丟棄並計數（fail-visible），不得排隊。
 */
export async function sealRawFrame(keys: RawKeyPort, payload: RawPayload): Promise<Uint8Array | null> {
  const sk = keys.getSendKeyWithEpoch();
  if (!sk) return null;
  const isString = typeof payload === 'string';
  const plain: Uint8Array = isString ? new TextEncoder().encode(payload) : payload;
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, sk.key, plain as BufferSource);

  const frame = new Uint8Array(HEADER_LEN + ct.byteLength);
  frame[0] = VER;
  frame[1] = isString ? FLAG_STRING : 0;
  new DataView(frame.buffer).setUint32(2, sk.epoch >>> 0, false);
  frame.set(iv, 6);
  frame.set(new Uint8Array(ct), HEADER_LEN);
  return frame;
}

/**
 * 開封。格式不符、無該代金鑰、或 GCM 驗證失敗 → 拋錯（呼叫端丟棄＋計數）。
 * 回傳型別跟隨送端（字串進字串出、二進位進二進位出）。
 */
export async function openRawFrame(keys: RawKeyPort, frame: Uint8Array): Promise<RawPayload> {
  if (frame.length < HEADER_LEN + 16) throw new Error('raw frame too short'); // 16 = GCM tag 最小
  if (frame[0] !== VER) throw new Error(`unknown raw frame version ${frame[0]}`);
  const isString = (frame[1]! & FLAG_STRING) !== 0;
  const epoch = new DataView(frame.buffer, frame.byteOffset).getUint32(2, false);
  const key = keys.getKeyForEpoch(epoch);
  if (!key) throw new Error(`no room key for epoch ${epoch}`);
  // slice（複製）而非 subarray：TS 的 BufferSource 不含 SharedArrayBuffer 視圖，
  // 且 slice 保證是獨立 ArrayBuffer，餵 SubtleCrypto 最安全。
  const iv = frame.slice(6, HEADER_LEN);
  const ct = frame.slice(HEADER_LEN);
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ct);
  return isString ? new TextDecoder().decode(pt) : new Uint8Array(pt);
}
