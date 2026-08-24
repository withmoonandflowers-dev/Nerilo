/**
 * Spec 026 T5／V1：檔案傳輸真瀏覽器驗證。
 * 同頁兩 client（各自 identityNamespace）、真 WebRTC、真房金鑰密封。
 * A 送 4MB 隨機資料給 B，驗 SHA-256 一致並顯示吞吐。
 */
import {
  InMemorySignalingHub,
  InMemorySignalingTransport,
  InMemoryRoomDirectory,
  InMemoryRoomDirectoryHub,
} from 'nerilo';
import { createTransportClient } from 'nerilo/transport';

const ROOM = 'file-demo';
const SIZE = 4 * 1024 * 1024;
const sigHub = new InMemorySignalingHub();
const dirHub = new InMemoryRoomDirectoryHub();
const logEl = document.getElementById('log')!;
const verdict = document.getElementById('verdict')!;
const bar = document.getElementById('bar') as HTMLProgressElement;
const pct = document.getElementById('pct')!;
const log = (s: string) => { logEl.textContent += '\n' + s; };

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const d = await crypto.subtle.digest('SHA-256', bytes.slice().buffer as ArrayBuffer);
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function randomBytes(n: number): Uint8Array {
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i += 65536) crypto.getRandomValues(out.subarray(i, Math.min(i + 65536, n)));
  return out;
}

async function mk(name: string) {
  return createTransportClient({
    roomId: ROOM, userId: name, identityNamespace: name,
    signaling: (r, ch) => new InMemorySignalingTransport(sigHub, r, ch),
    directory: new InMemoryRoomDirectory(dirHub, ROOM, name),
  });
}

async function main(): Promise<void> {
  const A = await mk('A');
  const B = await mk('B');

  const received = new Promise<{ data: Uint8Array }>((res, rej) => {
    B.onFileOffer((offer) => {
      log(`B 收到 offer：${offer.name}（${offer.size} bytes）→ 接受`);
      const rx = offer.accept();
      rx.onProgress((got, total) => {
        const p = Math.round((got / total) * 100);
        bar.value = p; pct.textContent = `${p}%`;
      });
      rx.done.then(res, rej);
    });
  });

  await Promise.all([A.connect(), B.connect()]);
  log('等待傳輸與金鑰就緒…');
  await Promise.all([A, B].map((c) => new Promise<void>((res) => {
    const off = c.onStatus((s) => { if (s.transport === 'p2p' && s.encryption === 'ready') { off(); res(); } });
  })));

  const payload = randomBytes(SIZE);
  const sentSha = await sha256Hex(payload);
  log(`就緒。A 送 ${SIZE} bytes（sha256 ${sentSha.slice(0, 12)}…）`);
  const t0 = performance.now();
  const tx = A.sendFile(B.userId ? A.peers()[0]! : '', payload, { name: 'assets.bin', mime: 'application/octet-stream' });
  await tx.done;
  const { data } = await received;
  const ms = performance.now() - t0;
  const gotSha = await sha256Hex(data);
  const pass = gotSha === sentSha;
  const mbps = (SIZE / 1024 / 1024) / (ms / 1000);
  verdict.className = pass ? 'pass' : 'fail';
  verdict.textContent = pass
    ? `PASS：SHA-256 一致，${(ms / 1000).toFixed(2)}s，吞吐 ${mbps.toFixed(1)} MB/s（含加密）`
    : `FAIL：sha 不一致 ${sentSha.slice(0, 12)} vs ${gotSha.slice(0, 12)}`;
  log(verdict.textContent);
}

main().catch((e) => { verdict.className = 'fail'; verdict.textContent = `失敗：${e?.message ?? e}`; });
