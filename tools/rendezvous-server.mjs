#!/usr/bin/env node
/**
 * nerilo-rendezvous — 區網本地會合點（Spec 027）。
 *
 * 讓斷外網的區域網（社區路由器、手機熱點）內的裝置能交換 WebRTC 連線資訊。
 * 零依賴（Node 內建 http）、無持久化、無帳號，行程結束一切消失。
 *
 * 用法：npx nerilo-rendezvous [port]     # 預設 9473
 * 瀏覽器端：直接瀏覽 http://<這台的區網IP>:9473 就有現成聊天頁（斷網時 app 由會合點供應）；
 * 或自己的 app 注入 createHttpSignaling / createHttpRoomDirectory。
 *
 * 誠實邊界：無認證——同區網任何人都能讀寫 signaling 並加入房間。這與「一張邀請碼
 * 全村可用」是同一個信任模型：災難情境下的區網即信任邊界。不要把它暴露到公網。
 */
import { createServer } from 'node:http';
import { networkInterfaces } from 'node:os';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// 內建聊天頁（單檔，build:rendezvous-app 產出）：斷網時裝置瀏覽會合點即可用
const APP_PATH = join(dirname(fileURLToPath(import.meta.url)), 'rendezvous-app.html');
const APP_HTML = existsSync(APP_PATH) ? readFileSync(APP_PATH, 'utf8') : null;

const PORT = Number(process.argv[2]) || 9473;
/** roomId → { signals: [{doc, createdAtMs, seq}], nextSeq } */
const rooms = new Map();
const MAX_SIGNALS_PER_ROOM = 500; // 握手訊號量極小；上限防餵爆記憶體
const MAX_BODY = 32 * 1024;       // 單筆 signal 上限（SDP ~10KB 已寬裕）

const room = (id) => {
  let r = rooms.get(id);
  if (!r) { r = { signals: [], nextSeq: 1, identities: {}, participants: [], dirVersion: 0 }; rooms.set(id, r); }
  return r;
};

const server = createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  const url = new URL(req.url, `http://${req.headers.host}`);

  // 名冊（IRoomDirectory over HTTP）：跨裝置成房必需——signaling 只交換連線資訊，
  // 「房裡有誰、各自的公鑰」靠名冊。upsert by uid；dirVersion 供輪詢端便宜判變。
  const md = url.pathname.match(/^\/rooms\/([A-Za-z0-9_-]{1,128})\/identities$/);
  if (md) {
    const r = room(md[1]);
    if (req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ meshIdentities: r.identities, participants: r.participants, version: r.dirVersion }));
      return;
    }
    if (req.method === 'POST') {
      let body = ''; let size = 0;
      req.on('data', (c) => {
        size += c.length;
        if (size > MAX_BODY) { res.writeHead(413); res.end(); req.destroy(); return; }
        body += c;
      });
      req.on('end', () => {
        let msg;
        try { msg = JSON.parse(body); } catch { res.writeHead(400); res.end(); return; }
        if (typeof msg?.uid !== 'string' || typeof msg?.identity !== 'object' || msg.identity === null) {
          res.writeHead(400); res.end(); return;
        }
        r.identities[msg.uid] = msg.identity;
        if (!r.participants.includes(msg.uid)) r.participants.push(msg.uid);
        r.dirVersion++;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ version: r.dirVersion }));
      });
      return;
    }
    res.writeHead(405); res.end(); return;
  }

  const m = url.pathname.match(/^\/rooms\/([A-Za-z0-9_-]{1,128})\/signals$/);
  if (!m) {
    if (url.pathname === '/') {
      if (APP_HTML) { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(APP_HTML); }
      else { res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end('nerilo-rendezvous ok（未內建聊天頁：先跑 npm run build:rendezvous-app）\n'); }
      return;
    }
    res.writeHead(404); res.end(); return;
  }
  const r = room(m[1]);

  if (req.method === 'GET') {
    const after = Number(url.searchParams.get('after')) || 0;
    const out = r.signals.filter((s) => s.seq > after);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ signals: out, seq: r.nextSeq - 1 }));
    return;
  }
  if (req.method === 'POST') {
    let body = '';
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) { res.writeHead(413); res.end(); req.destroy(); return; }
      body += c;
    });
    req.on('end', () => {
      let doc;
      try { doc = JSON.parse(body); } catch { res.writeHead(400); res.end(); return; }
      if (typeof doc !== 'object' || doc === null) { res.writeHead(400); res.end(); return; }
      const entry = {
        doc: { ...doc, signalId: `rz-${r.nextSeq}` },
        createdAtMs: typeof doc.createdAt === 'number' ? doc.createdAt : Date.now(),
        seq: r.nextSeq++,
      };
      r.signals.push(entry);
      if (r.signals.length > MAX_SIGNALS_PER_ROOM) r.signals.splice(0, r.signals.length - MAX_SIGNALS_PER_ROOM);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ seq: entry.seq }));
    });
    return;
  }
  res.writeHead(405); res.end();
});

server.listen(PORT, '0.0.0.0', () => {
  const ips = Object.values(networkInterfaces()).flat()
    .filter((i) => i && i.family === 'IPv4' && !i.internal).map((i) => i.address);
  console.log(`nerilo-rendezvous 已啟動（port ${PORT}，無認證——僅限信任的區網使用）`);
  console.log(APP_HTML ? '同區網的裝置用瀏覽器打開：' : '（無內建聊天頁）瀏覽器端這樣接：');
  for (const ip of ips.length ? ips : ['<這台的區網IP>']) {
    console.log(APP_HTML ? `  http://${ip}:${PORT}` : `  createHttpSignaling('http://${ip}:${PORT}')`);
  }
});
