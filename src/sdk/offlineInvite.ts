/**
 * 離線邀請碼（Spec 027）：雙向雙 QR 的零基礎設施配對。
 *
 * 流程：A `createOfflineInvite()` 產 offer 酬載（QR/文字）→ B `acceptOfflineInvite(酬載)`
 * 產 answer 酬載 → A `invite.complete(answer酬載)` → 兩端各得一條已連線的 OfflineLink。
 * 全程不需要任何伺服器與網際網路——回程管道就是第二張 QR（Spec 005 Q7 的物理限制，
 * 以「再掃一次」解掉）。
 *
 * 酬載：`nqr1.` 前綴＋deflate-raw＋base64url。datachannel-only 的 SDP 本來就小，
 * 壓縮後遠低於 QR byte 模式上限（2,953 bytes）；`payloadBytes()` 可查實際大小。
 * ICE 走 non-trickle（等蒐集完成才出酬載），因為離線情境沒有第二條路補送 candidate。
 *
 * 誠實邊界：
 *  - OfflineLink 是 DTLS 傳輸加密，**尚無房間金鑰 E2EE**（沒有 mesh 就沒有 keyx）；
 *    「兩人面對面互掃」本身即身分驗證。把此連線接進完整聊天房屬後續工作。
 *  - 持酬載者即可完成配對（Q4 拍板的信任模型）；酬載存活期＝A 端行程存活期。
 */

const MAGIC = 'nqr1.';
const QR_BYTE_CAP = 2953; // QR version 40, byte mode, EC level L

// ── 酬載編解碼（純函式，可直測）─────────────────────────────────────────────

async function deflate(bytes: Uint8Array): Promise<Uint8Array> {
  const cs = new CompressionStream('deflate-raw');
  const out = await new Response(new Blob([bytes as BlobPart]).stream().pipeThrough(cs)).arrayBuffer();
  return new Uint8Array(out);
}

async function inflate(bytes: Uint8Array): Promise<Uint8Array> {
  const ds = new DecompressionStream('deflate-raw');
  const out = await new Response(new Blob([bytes as BlobPart]).stream().pipeThrough(ds)).arrayBuffer();
  return new Uint8Array(out);
}

const b64url = {
  encode: (b: Uint8Array) => btoa(String.fromCharCode(...b)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''),
  decode: (s: string) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0)),
};

export interface InvitePayload {
  v: 'nqr1';
  role: 'o' | 'a';
  room?: string;
  sdp: string;
}

export async function encodeInvitePayload(p: InvitePayload): Promise<string> {
  const packed = await deflate(new TextEncoder().encode(JSON.stringify(p)));
  return MAGIC + b64url.encode(packed);
}

export async function decodeInvitePayload(s: string): Promise<InvitePayload> {
  if (!s.startsWith(MAGIC)) throw new Error('not a nerilo offline invite (missing nqr1 prefix)');
  const raw = await inflate(b64url.decode(s.slice(MAGIC.length)));
  const p = JSON.parse(new TextDecoder().decode(raw)) as InvitePayload;
  if (p?.v !== 'nqr1' || (p.role !== 'o' && p.role !== 'a') || typeof p.sdp !== 'string') {
    throw new Error('malformed offline invite payload');
  }
  return p;
}

/** 酬載實際 byte 數與 QR 上限（驗收與 UI 提示用）。 */
export function payloadBytes(payload: string): { bytes: number; fitsInSingleQr: boolean } {
  const bytes = new TextEncoder().encode(payload).length;
  return { bytes, fitsInSingleQr: bytes <= QR_BYTE_CAP };
}

// ── 連線層（瀏覽器；真 RTCPeerConnection）───────────────────────────────────

export interface OfflineLink {
  send(text: string): void;
  onMessage(cb: (text: string) => void): () => void;
  onClose(cb: () => void): () => void;
  close(): void;
}

function wrap(pc: RTCPeerConnection, dc: RTCDataChannel): OfflineLink {
  const msg = new Set<(t: string) => void>();
  const closed = new Set<() => void>();
  dc.onmessage = (e) => msg.forEach((cb) => { try { cb(String(e.data)); } catch { /* listener 錯誤不擴散 */ } });
  dc.onclose = () => closed.forEach((cb) => { try { cb(); } catch { /* ignore */ } });
  return {
    send: (t) => { if (dc.readyState === 'open') dc.send(t); },
    onMessage: (cb) => { msg.add(cb); return () => msg.delete(cb); },
    onClose: (cb) => { closed.add(cb); return () => closed.delete(cb); },
    close: () => { try { dc.close(); } catch { /* ignore */ } try { pc.close(); } catch { /* ignore */ } },
  };
}

/** 等 ICE 蒐集完成（non-trickle：離線情境沒有補送 candidate 的第二條路）。 */
function gathered(pc: RTCPeerConnection): Promise<void> {
  if (pc.iceGatheringState === 'complete') return Promise.resolve();
  return new Promise((res) => {
    const check = () => {
      if (pc.iceGatheringState === 'complete') { pc.removeEventListener('icegatheringstatechange', check); res(); }
    };
    pc.addEventListener('icegatheringstatechange', check);
  });
}

export interface OfflineInvite {
  /** 給對方掃的 offer 酬載（QR 或任何文字管道）。 */
  payload: string;
  /** 收回對方的 answer 酬載，完成握手；resolve 時通道已開。 */
  complete(answerPayload: string): Promise<OfflineLink>;
  /** 放棄（關閉底層連線）。 */
  cancel(): void;
}

/** A 端：建立離線邀請。iceServers 預設空（同區網 host candidates 即可直連）。 */
export async function createOfflineInvite(opts?: { room?: string; iceServers?: RTCIceServer[] }): Promise<OfflineInvite> {
  const pc = new RTCPeerConnection({ iceServers: opts?.iceServers ?? [] });
  const dc = pc.createDataChannel('offline-invite', { ordered: true });
  await pc.setLocalDescription(await pc.createOffer());
  await gathered(pc);
  const payload = await encodeInvitePayload({
    v: 'nqr1', role: 'o', sdp: pc.localDescription!.sdp,
    ...(opts?.room ? { room: opts.room } : {}),
  });
  return {
    payload,
    async complete(answerPayload) {
      const ans = await decodeInvitePayload(answerPayload);
      if (ans.role !== 'a') throw new Error('expected an answer payload (role a)');
      await pc.setRemoteDescription({ type: 'answer', sdp: ans.sdp });
      await new Promise<void>((res, rej) => {
        if (dc.readyState === 'open') return res();
        const to = setTimeout(() => rej(new Error('offline invite: channel open timeout')), 30_000);
        dc.onopen = () => { clearTimeout(to); res(); };
        dc.onerror = () => { clearTimeout(to); rej(new Error('offline invite: channel failed')); };
      });
      return wrap(pc, dc);
    },
    cancel: () => { try { pc.close(); } catch { /* ignore */ } },
  };
}

/** B 端：掃到 offer 酬載後接受，產生要回掃的 answer 酬載。 */
export async function acceptOfflineInvite(
  offerPayload: string,
  opts?: { iceServers?: RTCIceServer[] }
): Promise<{ payload: string; room?: string; link: Promise<OfflineLink> }> {
  const offer = await decodeInvitePayload(offerPayload);
  if (offer.role !== 'o') throw new Error('expected an offer payload (role o)');
  const pc = new RTCPeerConnection({ iceServers: opts?.iceServers ?? [] });
  const linkReady = new Promise<OfflineLink>((res, rej) => {
    const to = setTimeout(() => rej(new Error('offline invite: channel open timeout')), 60_000);
    pc.ondatachannel = (e) => {
      const dc = e.channel;
      if (dc.readyState === 'open') { clearTimeout(to); res(wrap(pc, dc)); }
      else dc.onopen = () => { clearTimeout(to); res(wrap(pc, dc)); };
    };
  });
  await pc.setRemoteDescription({ type: 'offer', sdp: offer.sdp });
  await pc.setLocalDescription(await pc.createAnswer());
  await gathered(pc);
  const payload = await encodeInvitePayload({ v: 'nqr1', role: 'a', sdp: pc.localDescription!.sdp });
  return { payload, ...(offer.room ? { room: offer.room } : {}), link: linkReady };
}
