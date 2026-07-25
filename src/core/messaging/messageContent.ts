/**
 * 訊息內容編碼：把「回覆對象」嵌進內容字串（純邏輯，可測）
 *
 * 為什麼嵌進內容而非另開 metadata：內容字串整條被房間 sender key 加密（E2EE），
 * 因此「回覆了哪一則」也隨之加密，只有房內成員看得到，relay/備援看到的是密文。
 * 傳輸層（mesh gossip / Firestore 備援 / IndexedDB）一律把它當不透明字串，不需改動。
 *
 * 向下相容：純文字訊息 encode 後原樣返回（不帶標記），舊訊息與非回覆訊息完全不受影響
 * ——golden-path「bubble 文字 == 送出文字」不變。只有回覆訊息才帶標記前綴 + JSON。
 */

/** 罕見控制字元前綴，正常輸入幾乎不可能出現；後接 {r,t} JSON。 */
const REPLY_MARKER = 'nrl-reply';

export interface DecodedContent {
  text: string;
  /** 被回覆訊息的 messageId（無則非回覆）。 */
  replyTo?: string;
}

/** 送出時：有回覆對象才包標記，否則原樣（純文字）。 */
export function encodeContent(text: string, replyTo?: string): string {
  if (!replyTo) return text;
  return REPLY_MARKER + JSON.stringify({ r: replyTo, t: text });
}

/** 顯示時：解出 {text, replyTo}。非標記字串 / 壞資料一律當純文字（安全降級）。 */
export function decodeContent(raw: unknown): DecodedContent {
  if (typeof raw !== 'string') return { text: '' };
  if (!raw.startsWith(REPLY_MARKER)) return { text: raw };
  try {
    const o = JSON.parse(raw.slice(REPLY_MARKER.length)) as { r?: unknown; t?: unknown };
    if (typeof o.t === 'string' && typeof o.r === 'string') return { text: o.t, replyTo: o.r };
  } catch {
    /* 壞資料 → 當純文字 */
  }
  return { text: raw };
}
