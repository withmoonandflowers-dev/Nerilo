/**
 * InviteRendezvous — 邀請連結內嵌會合資訊（Spec 005 T4，Q1 拍板）。
 *
 * 邀請連結不只帶 roomId，還嵌「邀請者身分」：被邀請者一進來就知道
 * （1）該指名誰當首個 warm 目標（bootstrap 第一跳後、其餘連線經他介紹），
 * （2）邀請者的公鑰——信任根來自連結本身（頻外交換），不必信任伺服器名冊，
 *     惡意伺服器換鑰（MITM）可被比對抓到。
 *
 * 放 URL fragment（#）而非 query：fragment 不上送伺服器，hosting/代理 log 不落
 * 會合資訊。編碼＝base64url(JSON)，版本標記 v:'nrz1'。
 *
 * 誠實邊界：房內容金鑰**不**放連結。E2EE 金鑰由 keyx 協議在成員間成對封裝分發
 * （ADR-0023 P2），連結外洩不等於金鑰外洩；spec §4.3 的「房金鑰」以 keyx 履行。
 *
 * 純函數、零 I/O。
 */

export interface InviteRendezvous {
  v: 'nrz1';
  /** 房間 id。 */
  room: string;
  /** 邀請者（會合目標）。 */
  inviter: {
    /** 邀請者 signaling uid（被邀請者指名的首個 warm 目標）。 */
    uid: string;
    /** 邀請者 ECDSA 身分公鑰（Base64 SPKI，可選——供頻外信任根比對）。 */
    pubKey?: string;
    /** 邀請者 ECDH 公鑰（Base64 SPKI，可選）。 */
    ecdhPubKey?: string;
  };
}

/** fragment 參數名。 */
const FRAGMENT_KEY = 'nrz';

/**
 * sessionStorage 鍵前綴：被邀請者在 waiting 頁解析到會合資訊後暫存，
 * 導頁到 chat 後讀出（fragment 不會跟著路由走）。sessionStorage＝分頁生命週期，
 * 關分頁即清，不留長期足跡。
 */
export const INTRODUCER_STORE_PREFIX = 'nerilo:introducer:';
export const introducerStoreKey = (roomId: string): string => `${INTRODUCER_STORE_PREFIX}${roomId}`;

function toBase64Url(s: string): string {
  const b64 = btoa(unescape(encodeURIComponent(s)));
  return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(s: string): string {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/');
  const pad = b64.length % 4 === 0 ? '' : '='.repeat(4 - (b64.length % 4));
  return decodeURIComponent(escape(atob(b64 + pad)));
}

/** 編碼會合資訊 → fragment 值。 */
export function encodeInviteRendezvous(rz: Omit<InviteRendezvous, 'v'>): string {
  const full: InviteRendezvous = { v: 'nrz1', ...rz };
  return toBase64Url(JSON.stringify(full));
}

/** 組完整邀請連結：{origin}/waiting/{room}#nrz={encoded}。 */
export function buildInviteUrl(origin: string, rz: Omit<InviteRendezvous, 'v'>): string {
  return `${origin}/waiting/${rz.room}#${FRAGMENT_KEY}=${encodeInviteRendezvous(rz)}`;
}

/**
 * 從 fragment（'#nrz=...' 或 'nrz=...' 或整條 URL）解析會合資訊。
 * 任何不合法（壞編碼/壞 JSON/版本不符/欄位缺漏/型別錯）→ null（邀請連結來自
 * 不可信輸入，絕不拋錯炸 UI）。
 */
export function parseInviteRendezvous(hashOrUrl: string): InviteRendezvous | null {
  try {
    const hashIdx = hashOrUrl.indexOf('#');
    const frag = hashIdx >= 0 ? hashOrUrl.slice(hashIdx + 1) : hashOrUrl;
    const params = new URLSearchParams(frag);
    const encoded = params.get(FRAGMENT_KEY);
    if (!encoded) return null;
    const parsed = JSON.parse(fromBase64Url(encoded)) as Partial<InviteRendezvous>;
    if (parsed?.v !== 'nrz1') return null;
    if (typeof parsed.room !== 'string' || parsed.room.length === 0) return null;
    const inviter = parsed.inviter as Partial<InviteRendezvous['inviter']> | undefined;
    if (!inviter || typeof inviter.uid !== 'string' || inviter.uid.length === 0) return null;
    if (inviter.pubKey !== undefined && typeof inviter.pubKey !== 'string') return null;
    if (inviter.ecdhPubKey !== undefined && typeof inviter.ecdhPubKey !== 'string') return null;
    return {
      v: 'nrz1',
      room: parsed.room,
      inviter: {
        uid: inviter.uid,
        ...(inviter.pubKey ? { pubKey: inviter.pubKey } : {}),
        ...(inviter.ecdhPubKey ? { ecdhPubKey: inviter.ecdhPubKey } : {}),
      },
    };
  } catch {
    return null;
  }
}
