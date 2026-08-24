/**
 * 大型二進位傳輸（Spec 026）：offer/accept、分塊、ack 視窗流控、SHA-256 端到端驗證、取消。
 *
 * 騎 raw 通道可靠模式（label 'file'，保留字，比照 'state' 先例），每筆傳輸專用通道、
 * 傳完即關。加密走 raw 密封管線（房金鑰）。可靠性只及連線存續期間：斷線＝失敗
 * （fail-visible），不做續傳；組裝在記憶體，上限 64MB——更大的東西請走 CDN/自有後端，
 * P2P 房間不是搬它們的工具。
 */

import { logger } from '../utils/logger';

export const FILE_CHANNEL_LABEL = 'file';
const DEFAULT_CHUNK_BYTES = 16 * 1024;     // 跨瀏覽器安全值
const WINDOW_CHUNKS = 32;                  // in-flight ≤ 32 chunks（512KB）
const MAX_FILE_BYTES = 64 * 1024 * 1024;   // 記憶體組裝上限

/** chunk 線上格式：[id u32 BE][seq u32 BE][bytes]。純函式，可直測。 */
export function encodeChunk(id: number, seq: number, bytes: Uint8Array): Uint8Array {
  const out = new Uint8Array(8 + bytes.length);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, id >>> 0, false);
  dv.setUint32(4, seq >>> 0, false);
  out.set(bytes, 8);
  return out;
}

export function decodeChunk(frame: Uint8Array): { id: number; seq: number; bytes: Uint8Array } {
  if (frame.length < 8) throw new Error('file chunk too short');
  const dv = new DataView(frame.buffer, frame.byteOffset);
  return { id: dv.getUint32(0, false), seq: dv.getUint32(4, false), bytes: frame.slice(8) };
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes.slice().buffer as ArrayBuffer);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** 傳輸通道所需最小面（RawChannel 子集；close 必要——傳完即關）。 */
export interface FileChannelLike {
  readonly peerId: string;
  send(data: string | Uint8Array): void;
  onMessage(cb: (data: string | Uint8Array, from: string) => void): () => void;
  onClose(cb: () => void): () => void;
  close(): void;
}

export interface FileTransportPort {
  openFileChannel(peerId: string): Promise<FileChannelLike>;
}

export interface FileSend {
  onProgress(cb: (sent: number, total: number) => void): () => void;
  /** resolve＝對方驗證通過；reject＝拒收／取消／斷線／驗證失敗。 */
  done: Promise<void>;
  cancel(): void;
}

export interface FileReceive {
  onProgress(cb: (got: number, total: number) => void): () => void;
  done: Promise<{ data: Uint8Array; name?: string; mime?: string }>;
  cancel(): void;
}

export interface FileOffer {
  readonly peerId: string;
  readonly name?: string;
  readonly mime?: string;
  readonly size: number;
  accept(): FileReceive;
  reject(reason?: string): void;
}

type Ctl =
  | { t: 'o'; id: number; name?: string; mime?: string; size: number; chunk: number; sha: string }
  | { t: 'a'; id: number }
  | { t: 'r'; id: number; reason?: string }
  | { t: 'k'; id: number; upTo: number }
  | { t: 'd'; id: number; ok: boolean }
  | { t: 'c'; id: number };

export class FileTransferManager {
  private offerHandler: ((offer: FileOffer) => void) | null = null;
  private nextId = 1;

  constructor(private port: FileTransportPort) {}

  /** 註冊收檔處理器（單一 handler，後註冊者取代前者）。未註冊＝一律自動拒收。 */
  onFileOffer(cb: (offer: FileOffer) => void): () => void {
    this.offerHandler = cb;
    return () => { if (this.offerHandler === cb) this.offerHandler = null; };
  }

  sendFile(peerId: string, data: Uint8Array, meta?: { name?: string; mime?: string }): FileSend {
    if (data.length > MAX_FILE_BYTES) {
      throw new Error(`file too large (${data.length} > ${MAX_FILE_BYTES}); use a CDN/backend for assets this size`);
    }
    const id = this.nextId++;
    const progress = new Set<(sent: number, total: number) => void>();
    let cancelled = false;
    let cancelFn: () => void = () => { cancelled = true; }; // 握手完成前取消＝旗標，握手後生效

    const done = (async () => {
      const sha = await sha256Hex(data);
      if (cancelled) throw new Error('cancelled by sender');
      const ch = await this.port.openFileChannel(peerId);
      if (cancelled) { ch.close(); throw new Error('cancelled by sender'); }
      await new Promise<void>((resolve, reject) => {
        let ackedUpTo = -1;
        let nextSeq = 0;
        const totalChunks = Math.ceil(data.length / DEFAULT_CHUNK_BYTES) || 1;
        let settled = false;
        const finish = (err?: Error) => {
          if (settled) return;
          settled = true;
          ch.close();
          err ? reject(err) : resolve();
        };
        cancelFn = () => {
          try { ch.send(JSON.stringify({ t: 'c', id } satisfies Ctl)); } catch { /* 關閉中 */ }
          finish(new Error('cancelled by sender'));
        };
        const pump = () => {
          while (nextSeq < totalChunks && nextSeq - ackedUpTo <= WINDOW_CHUNKS) {
            const start = nextSeq * DEFAULT_CHUNK_BYTES;
            ch.send(encodeChunk(id, nextSeq, data.subarray(start, Math.min(start + DEFAULT_CHUNK_BYTES, data.length))));
            nextSeq++;
            const sent = Math.min(nextSeq * DEFAULT_CHUNK_BYTES, data.length);
            progress.forEach((cb) => { try { cb(sent, data.length); } catch { /* ignore */ } });
          }
        };
        ch.onClose(() => finish(new Error('channel closed before completion')));
        ch.onMessage((raw) => {
          if (typeof raw !== 'string') return; // 送方不收 chunk
          let m: Ctl;
          try { m = JSON.parse(raw) as Ctl; } catch { return; }
          if (m.id !== id) return;
          if (m.t === 'a') pump();
          else if (m.t === 'r') finish(new Error(`rejected: ${m.reason ?? 'unspecified'}`));
          else if (m.t === 'k') { ackedUpTo = m.upTo; pump(); }
          else if (m.t === 'd') finish(m.ok ? undefined : new Error('integrity check failed on receiver'));
          else if (m.t === 'c') finish(new Error('cancelled by receiver'));
        });
        ch.send(JSON.stringify({
          t: 'o', id, size: data.length, chunk: DEFAULT_CHUNK_BYTES, sha,
          ...(meta?.name ? { name: meta.name } : {}), ...(meta?.mime ? { mime: meta.mime } : {}),
        } satisfies Ctl));
      });
    })();

    return {
      onProgress: (cb) => { progress.add(cb); return () => progress.delete(cb); },
      done,
      cancel: () => cancelFn(),
    };
  }

  /** transport client 把 label 'file' 的入站通道分流到這裡。 */
  acceptInbound(ch: FileChannelLike): void {
    let offer: (Ctl & { t: 'o' }) | null = null;
    let buf: Uint8Array | null = null;
    let got = 0;
    let gotChunks = 0;
    let settled = false;
    const progress = new Set<(got: number, total: number) => void>();
    let resolveDone: (v: { data: Uint8Array; name?: string; mime?: string }) => void;
    let rejectDone: (e: Error) => void;
    const done = new Promise<{ data: Uint8Array; name?: string; mime?: string }>((res, rej) => {
      resolveDone = res; rejectDone = rej;
    });
    done.catch(() => { /* 未 accept 前的拒收路徑沒有 done 消費者，吞掉避免 unhandled */ });
    const finish = (err?: Error, result?: { data: Uint8Array; name?: string; mime?: string }) => {
      if (settled) return;
      settled = true;
      ch.close();
      err ? rejectDone(err) : resolveDone(result!);
    };
    ch.onClose(() => finish(new Error('channel closed before completion')));

    ch.onMessage((raw) => {
      if (typeof raw === 'string') {
        let m: Ctl;
        try { m = JSON.parse(raw) as Ctl; } catch { return; }
        if (m.t === 'o') {
          offer = m;
          if (m.size > MAX_FILE_BYTES) {
            ch.send(JSON.stringify({ t: 'r', id: m.id, reason: 'too-large' } satisfies Ctl));
            finish(new Error('offer too large'));
            return;
          }
          const handler = this.offerHandler;
          if (!handler) {
            ch.send(JSON.stringify({ t: 'r', id: m.id, reason: 'no-handler' } satisfies Ctl));
            finish(new Error('no file offer handler registered'));
            return;
          }
          const o = m;
          handler({
            peerId: ch.peerId,
            name: o.name, mime: o.mime, size: o.size,
            accept: (): FileReceive => {
              buf = new Uint8Array(o.size);
              ch.send(JSON.stringify({ t: 'a', id: o.id } satisfies Ctl));
              return {
                onProgress: (cb) => { progress.add(cb); return () => progress.delete(cb); },
                done,
                cancel: () => {
                  try { ch.send(JSON.stringify({ t: 'c', id: o.id } satisfies Ctl)); } catch { /* 關閉中 */ }
                  finish(new Error('cancelled by receiver'));
                },
              };
            },
            reject: (reason?: string) => {
              ch.send(JSON.stringify({ t: 'r', id: o.id, reason } satisfies Ctl));
              finish(new Error(`rejected locally: ${reason ?? 'unspecified'}`));
            },
          });
        } else if (m.t === 'c') {
          finish(new Error('cancelled by sender'));
        }
        return;
      }
      // 二進位 chunk
      if (!offer || !buf) return; // 未 accept 前不收資料（防禦）
      let decoded: { id: number; seq: number; bytes: Uint8Array };
      try { decoded = decodeChunk(raw); } catch { return; }
      if (decoded.id !== offer.id) return;
      const start = decoded.seq * offer.chunk;
      if (start + decoded.bytes.length > buf.length) {
        logger.warn('[FileTransfer] chunk out of bounds — dropping transfer');
        finish(new Error('malformed chunk (out of bounds)'));
        return;
      }
      buf.set(decoded.bytes, start);
      got += decoded.bytes.length;
      gotChunks++;
      progress.forEach((cb) => { try { cb(got, offer!.size); } catch { /* ignore */ } });
      const totalChunks = Math.ceil(offer.size / offer.chunk) || 1;
      if (gotChunks % WINDOW_CHUNKS === 0 || gotChunks === totalChunks) {
        ch.send(JSON.stringify({ t: 'k', id: offer.id, upTo: gotChunks - 1 } satisfies Ctl));
      }
      if (got >= offer.size) {
        void (async () => {
          const o = offer!;
          const data = buf!;
          const ok = (await sha256Hex(data)) === o.sha;
          ch.send(JSON.stringify({ t: 'd', id: o.id, ok } satisfies Ctl));
          if (ok) finish(undefined, { data, ...(o.name ? { name: o.name } : {}), ...(o.mime ? { mime: o.mime } : {}) });
          else finish(new Error('integrity check failed'));
        })();
      }
    });
  }
}
