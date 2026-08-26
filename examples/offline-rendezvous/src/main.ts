/**
 * Spec 027 T6：斷網會合驗證。
 * 第一幕（V1 結構性證據）：兩個 transport client 經「本地會合點」（localhost:9473）成房，
 *   P2P+金鑰就緒後互傳——全程只碰 localhost，證明不依賴任何外部服務。
 * 第二幕（V2）：createOfflineInvite/acceptOfflineInvite 僅交換兩段酬載（模擬雙 QR 互掃），
 *   建立 OfflineLink 互傳——連會合點都不用。
 */
import {
  createHttpSignaling,
  createOfflineInvite,
  acceptOfflineInvite,
  payloadBytes,
  InMemoryRoomDirectory,
  InMemoryRoomDirectoryHub,
} from 'nerilo';
import { createTransportClient } from 'nerilo/transport';

const $ = (id: string) => document.getElementById(id)!;
const log1 = (s: string) => { $('log1').textContent += '\n' + s; };
const log2 = (s: string) => { $('log2').textContent += '\n' + s; };

// ── 第一幕：本地會合點 ───────────────────────────────────────────────────────
async function act1(): Promise<void> {
  const RENDEZVOUS = 'http://127.0.0.1:9473';
  try {
    const ping = await fetch(RENDEZVOUS);
    if (!ping.ok) throw new Error(String(ping.status));
  } catch {
    $('verdict1').className = 'fail';
    $('verdict1').textContent = '會合點不在線。啟動：node tools/rendezvous-server.mjs 9473';
    return;
  }
  log1('會合點在線。建兩個 client（signaling 走本地會合點；名冊走同頁 hub）…');

  const dirHub = new InMemoryRoomDirectoryHub();
  // 房名帶時戳：會合點無清理 API（無狀態設計），重複用同名房會吃到先前會話的
  // 舊信號回放——每場會話用新房名是正確用法，文件同句話。
  const roomId = `shelter-${Date.now().toString(36)}`;
  const mk = (uid: string) => createTransportClient({
    roomId, userId: uid, identityNamespace: `${uid}-${roomId}`,
    signaling: createHttpSignaling(RENDEZVOUS, { pollMs: 300 }),
    directory: new InMemoryRoomDirectory(dirHub, roomId, uid),
  });
  const A = await mk('A');
  const B = await mk('B');
  await Promise.all([A.connect(), B.connect()]);
  await Promise.all([A, B].map((c) => new Promise<void>((res) => {
    const off = c.onStatus((s) => { if (s.transport === 'p2p' && s.encryption === 'ready') { off(); res(); } });
  })));
  log1('P2P 成形＋房間金鑰就緒（signaling 只經 127.0.0.1 會合點）');

  const got = new Promise<string>((res) => {
    B.onRawChannel((ch) => ch.onMessage((d) => res(String(d))));
  });
  const ch = await A.openRawChannel(B.userId ? A.peers()[0]! : '', 'msg', { ordered: true });
  ch.send('斷外網情境測試：這句經 P2P 直連，加密後只在兩台裝置之間');
  const text = await got;
  log1(`B 收到：「${text}」`);

  const external = performance.getEntriesByType('resource')
    .map((e) => new URL((e as PerformanceResourceTiming).name, location.href))
    .filter((u) => u.hostname !== '127.0.0.1' && u.hostname !== 'localhost');
  const pass = text.includes('斷外網') && external.length === 0;
  $('verdict1').className = pass ? 'pass' : 'fail';
  $('verdict1').textContent = pass
    ? 'PASS：成房＋互傳成功，且本頁零外部網路請求（只碰 localhost）'
    : `FAIL：外部請求 ${external.length} 筆：${external.slice(0, 3).map((u) => u.hostname).join(', ')}`;
  await A.dispose(); await B.dispose();
}

// ── 第二幕：離線邀請碼 ───────────────────────────────────────────────────────
async function act2(): Promise<void> {
  log2('A 產生邀請酬載（等 ICE 蒐集完成）…');
  const invite = await createOfflineInvite({ room: 'shelter' });
  const { bytes, fitsInSingleQr } = payloadBytes(invite.payload);
  log2(`offer 酬載 ${bytes} bytes（單張 QR 上限 2953：${fitsInSingleQr ? 'OK' : '超限'}）`);
  $('payloads').textContent = `offer: ${invite.payload.slice(0, 120)}…`;

  log2('B「掃描」offer 酬載，產生 answer 酬載…');
  const accepted = await acceptOfflineInvite(invite.payload);
  const ansInfo = payloadBytes(accepted.payload);
  log2(`answer 酬載 ${ansInfo.bytes} bytes（${ansInfo.fitsInSingleQr ? 'OK' : '超限'}）`);
  $('payloads').textContent += `\nanswer: ${accepted.payload.slice(0, 120)}…`;

  log2('A「回掃」answer 酬載，完成握手…');
  const [linkA, linkB] = await Promise.all([invite.complete(accepted.payload), accepted.link]);

  const got = new Promise<string>((res) => linkB.onMessage((t) => res(t)));
  linkA.send('零伺服器配對成功：這條連線只靠兩段酬載建立');
  const text = await got;
  log2(`B 收到：「${text}」`);

  const pass = text.includes('零伺服器') && fitsInSingleQr && ansInfo.fitsInSingleQr;
  $('verdict2').className = pass ? 'pass' : 'fail';
  $('verdict2').textContent = pass
    ? `PASS：雙酬載（${bytes}B / ${ansInfo.bytes}B）建立直連並互傳，全程零 signaling 物件`
    : 'FAIL';
  linkA.close(); linkB.close();
}

void act1().catch((e) => { $('verdict1').className = 'fail'; $('verdict1').textContent = `失敗：${e?.message ?? e}`; });
void act2().catch((e) => { $('verdict2').className = 'fail'; $('verdict2').textContent = `失敗：${e?.message ?? e}`; });
