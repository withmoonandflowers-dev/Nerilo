/**
 * Spec 027：雙 QR 離線邀請的場測頁（呈現層）。
 *
 * 流程：發起方產 offer QR → 加入方掃描 → 加入方出示 answer QR → 發起方回掃 → 開聊。
 * 相機需要安全來源：本頁走 https（自簽，vite basic-ssl），手機接受一次憑證警告即可。
 * 掃不動時有複製貼上備援（酬載就是字串，QR 只是呈現層）。
 * 「自動自測」給無相機環境：產 QR → 從 canvas 讀像素 → jsQR 解回 → 比對酬載一致。
 */
import QRCode from 'qrcode';
import jsQR from 'jsqr';
import { createOfflineInvite, acceptOfflineInvite, payloadBytes, type OfflineLink } from 'nerilo';

const $ = (id: string) => document.getElementById(id)!;
const log = (s: string, cls = '') => {
  const div = document.createElement('div');
  if (cls) div.className = cls;
  div.textContent = s;
  $('log').appendChild(div);
};

async function showQr(payload: string): Promise<void> {
  const canvas = $('qr') as HTMLCanvasElement;
  await QRCode.toCanvas(canvas, payload, { errorCorrectionLevel: 'L', scale: 4, margin: 2 });
  canvas.style.display = 'block';
  ($('mine') as HTMLTextAreaElement).value = payload;
}

/** 開相機連續掃，掃到 nqr1 酬載即停。 */
async function scanQr(): Promise<string> {
  const video = $('video') as HTMLVideoElement;
  const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
  video.srcObject = stream;
  video.style.display = 'block';
  await video.play();
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  try {
    for (;;) {
      await new Promise((r) => setTimeout(r, 150));
      if (!video.videoWidth) continue;
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
      ctx.drawImage(video, 0, 0);
      const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
      const hit = jsQR(img.data, img.width, img.height);
      if (hit?.data.startsWith('nqr1.')) return hit.data;
    }
  } finally {
    stream.getTracks().forEach((t) => t.stop());
    video.style.display = 'none';
  }
}

function openChat(link: OfflineLink): void {
  $('qr').style.display = 'none';
  $('chat').style.display = 'block';
  const add = (who: string, text: string) => {
    const d = document.createElement('div');
    d.textContent = `${who}：${text}`;
    $('messages').appendChild(d);
  };
  link.onMessage((t) => add('對方', t));
  link.onClose(() => { add('系統', '連線已中斷'); });
  const send = () => {
    const input = $('input') as HTMLInputElement;
    const t = input.value.trim();
    if (!t) return;
    input.value = '';
    link.send(t);
    add('我', t);
  };
  $('send').addEventListener('click', send);
  $('input').addEventListener('keydown', (e) => { if ((e as KeyboardEvent).key === 'Enter') send(); });
  log('連線建立。這條通道不經任何伺服器。', 'ok');
}

// ── 發起方 ──
$('btn-host').addEventListener('click', () => void (async () => {
  log('產生邀請（等 ICE 蒐集完成）…');
  const invite = await createOfflineInvite();
  const { bytes } = payloadBytes(invite.payload);
  log(`給對方掃這個 QR（${bytes} bytes）。對方掃完會出示回碼，按下面按鈕回掃。`);
  await showQr(invite.payload);
  const btn = document.createElement('button');
  btn.textContent = '掃描對方的回碼';
  btn.addEventListener('click', () => void (async () => {
    const answer = await scanQr();
    log('收到回碼，完成握手…');
    openChat(await invite.complete(answer));
  })().catch((e) => log(`失敗：${e.message}`, 'bad')));
  $('roles').replaceChildren(btn);
  // 貼上備援
  $('btn-paste').addEventListener('click', () => void (async () => {
    openChat(await invite.complete(($('paste') as HTMLTextAreaElement).value.trim()));
  })().catch((e) => log(`失敗：${e.message}`, 'bad')));
})().catch((e) => log(`失敗：${e.message}`, 'bad')));

// ── 加入方 ──
$('btn-join').addEventListener('click', () => void (async () => {
  const doAccept = async (offer: string) => {
    log('產生回碼（等 ICE 蒐集完成）…');
    const acc = await acceptOfflineInvite(offer);
    log(`請對方回掃這個 QR（${payloadBytes(acc.payload).bytes} bytes），等待連線…`);
    await showQr(acc.payload);
    openChat(await acc.link);
  };
  $('btn-paste').addEventListener('click', () => void doAccept(($('paste') as HTMLTextAreaElement).value.trim())
    .catch((e) => log(`失敗：${e.message}`, 'bad')));
  log('開相機掃發起方的 QR…（掃不動可用下方貼上備援）');
  const offer = await scanQr();
  await doAccept(offer);
})().catch((e) => log(`失敗：${e.message}`, 'bad')));

// ── 自動自測（無相機環境；驗 QR 呈現層往返）──
$('btn-selftest').addEventListener('click', () => void (async () => {
  log('自測：產生真實邀請酬載 → 畫成 QR → 讀回像素 → jsQR 解碼 → 比對…');
  const invite = await createOfflineInvite();
  const canvas = $('qr') as HTMLCanvasElement;
  await QRCode.toCanvas(canvas, invite.payload, { errorCorrectionLevel: 'L', scale: 4, margin: 2 });
  canvas.style.display = 'block';
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const hit = jsQR(img.data, img.width, img.height);
  invite.cancel();
  const pass = hit?.data === invite.payload;
  const { bytes } = payloadBytes(invite.payload);
  log(pass
    ? `PASS：${bytes} bytes 酬載經 QR 畫面往返後逐字一致（QR ${canvas.width}px）`
    : `FAIL：解碼結果與酬載不一致（解到 ${hit ? hit.data.length + ' chars' : '無'}）`,
    pass ? 'ok' : 'bad');
})().catch((e) => log(`失敗：${e.message}`, 'bad')));
