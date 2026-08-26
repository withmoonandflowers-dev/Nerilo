import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { createHttpSignaling } from '../../src/sdk/httpSignaling';
import { encodeInvitePayload, decodeInvitePayload, payloadBytes } from '../../src/sdk/offlineInvite';
import type { RawSignalDoc } from '../../src/core/p2p/SignalingTransport.types';

/**
 * Spec 027 T2/T3：本地會合點 signaling 契約（對真 server）＋離線邀請碼酬載編解碼。
 * 連線層（真 RTCPeerConnection）由 examples/offline-rendezvous 瀏覽器驗證覆蓋（V2）。
 */

const PORT = 9899;
let server: ChildProcess;

beforeAll(async () => {
  server = spawn('node', ['tools/rendezvous-server.mjs', String(PORT)], { stdio: ['ignore', 'pipe', 'pipe'] });
  await new Promise<void>((res, rej) => {
    const to = setTimeout(() => rej(new Error('rendezvous server start timeout')), 10_000);
    server.stdout!.on('data', (d) => { if (String(d).includes('已啟動')) { clearTimeout(to); res(); } });
    server.on('exit', (c) => rej(new Error(`server exited early: ${c}`)));
  });
});

afterAll(() => { server?.kill(); });

const doc = (from: string, extra?: Partial<RawSignalDoc>): Record<string, unknown> => ({
  from, to: null, type: 'offer', payload: { sdp: 'v=0 test' }, channelLabel: 'ch', createdAt: Date.now(), ...extra,
});

const settle = (ms = 200) => new Promise((r) => setTimeout(r, ms));

describe('本地會合點 signaling 契約（真 HTTP server）', () => {
  it('A 送出 → B 輪詢收到；自己送的也回到自己的 subscriber（契約語義）', async () => {
    const factory = createHttpSignaling(`http://127.0.0.1:${PORT}`, { pollMs: 50 });
    const a = factory('room-1', 'ch');
    const b = factory('room-1', 'ch');
    const gotA: RawSignalDoc[] = [];
    const gotB: RawSignalDoc[] = [];
    const offA = a.subscribe(0, (d) => gotA.push(d));
    const offB = b.subscribe(0, (d) => gotB.push(d));
    await settle(100);

    await a.send(doc('alice'));
    await settle(300);
    expect(gotB.map((d) => d.from)).toEqual(['alice']); // 對方收到
    expect(gotA.map((d) => d.from)).toEqual(['alice']); // 自己也收到（消費端以 from 過濾）
    expect(gotB[0]!.signalId).toBeTruthy(); // server 端配發 signalId
    offA(); offB();
  });

  it('cutoff 回放：訂閱前送出的訊號，晚訂閱者仍補得到（cutoff 之後的）', async () => {
    const factory = createHttpSignaling(`http://127.0.0.1:${PORT}`, { pollMs: 50 });
    const a = factory('room-replay', 'ch');
    const cutoff = Date.now() - 1000;
    await a.send(doc('early'));
    await settle(100);

    const late = factory('room-replay', 'ch');
    const got: RawSignalDoc[] = [];
    const off = late.subscribe(cutoff, (d) => got.push(d));
    await settle(300);
    expect(got.map((d) => d.from)).toContain('early');
    off();
  });

  it('房間隔離：不同房互不可見', async () => {
    const factory = createHttpSignaling(`http://127.0.0.1:${PORT}`, { pollMs: 50 });
    const a = factory('room-x', 'ch');
    const spy = factory('room-y', 'ch');
    const got: RawSignalDoc[] = [];
    const off = spy.subscribe(0, (d) => got.push(d));
    await a.send(doc('x-only'));
    await settle(300);
    expect(got).toHaveLength(0);
    off();
  });

  it('會合點不可達：send 拋錯、subscribe 靜默重試不擊落', async () => {
    const factory = createHttpSignaling('http://127.0.0.1:9', { pollMs: 50 }); // port 9 不會有人聽
    const t = factory('room-dead', 'ch');
    await expect(t.send(doc('a'))).rejects.toThrow();
    const off = t.subscribe(0, () => {});
    await settle(150); // 輪詢失敗不得 throw / unhandled
    off();
  });
});

describe('離線邀請碼酬載（nqr1）', () => {
  // datachannel-only offer 的擬真 SDP（實際長度量級）
  const FAKE_SDP = [
    'v=0', 'o=- 4611731400430051336 2 IN IP4 127.0.0.1', 's=-', 't=0 0',
    'a=group:BUNDLE 0', 'a=extmap-allow-mixed', 'a=msid-semantic: WMS',
    'm=application 51843 UDP/DTLS/SCTP webrtc-datachannel',
    'c=IN IP4 192.168.1.23', 'a=candidate:2999745851 1 udp 2122260223 192.168.1.23 51843 typ host generation 0 network-id 1',
    'a=ice-ufrag:F7gI', 'a=ice-pwd:x9cml/YzichV2+XlhiMu8g', 'a=ice-options:trickle',
    'a=fingerprint:sha-256 ' + 'AB:'.repeat(31) + 'CD',
    'a=setup:actpass', 'a=mid:0', 'a=sctp-port:5000', 'a=max-message-size:262144',
  ].join('\r\n');

  it('編解碼往返；壓縮後遠低於單張 QR 上限', async () => {
    const payload = await encodeInvitePayload({ v: 'nqr1', role: 'o', room: 'shelter-3', sdp: FAKE_SDP });
    expect(payload.startsWith('nqr1.')).toBe(true);

    const { bytes, fitsInSingleQr } = payloadBytes(payload);
    expect(fitsInSingleQr).toBe(true);
    expect(bytes).toBeLessThan(1200); // 擬真 SDP 壓縮後的量級證據（上限 2953）

    const back = await decodeInvitePayload(payload);
    expect(back).toEqual({ v: 'nqr1', role: 'o', room: 'shelter-3', sdp: FAKE_SDP });
  });

  it('防禦：非 nqr1 前綴、畸形內容一律拒收', async () => {
    await expect(decodeInvitePayload('https://evil.example/xx')).rejects.toThrow(/nqr1/);
    const bad = 'nqr1.' + Buffer.from('not-deflate').toString('base64url');
    await expect(decodeInvitePayload(bad)).rejects.toThrow();
  });

  it('role 錯置可辨識（answer 酬載不會被當 offer 收）', async () => {
    const ans = await encodeInvitePayload({ v: 'nqr1', role: 'a', sdp: FAKE_SDP });
    const decoded = await decodeInvitePayload(ans);
    expect(decoded.role).toBe('a');
  });
});
