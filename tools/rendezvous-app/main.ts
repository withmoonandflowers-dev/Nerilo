/**
 * 會合點內建聊天頁（Spec 027）：斷網時，裝置只要瀏覽到會合點 IP 就能聊。
 * signaling 與名冊都指向本頁的 origin（就是會合點自己），訊息走 P2P＋房間金鑰 E2EE。
 */
import { createChatClient } from '../../src/sdk/firestore';
import { createHttpSignaling, createHttpRoomDirectory } from '../../src/sdk/httpSignaling';

const $ = (id: string) => document.getElementById(id)!;
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));

// 身分用 sessionStorage：每「分頁」一個（同分頁重載不換人）。不能用 localStorage——
// 它是整個 origin 共用，同機開兩個分頁會共用身分 → mesh 把對方當自己、永不連線
// （identityNamespace 同型缺陷的 app 層版本，實測踩到）。
const uid = sessionStorage.getItem('nrz-uid') ?? `u${Math.random().toString(36).slice(2, 10)}`;
sessionStorage.setItem('nrz-uid', uid);
let name = localStorage.getItem('nrz-name') ?? '';

const room = new URLSearchParams(location.search).get('room') ?? 'lobby';

async function main(): Promise<void> {
  if (!name) name = `訪客${uid.slice(1, 5)}`;
  $('room').textContent = `房間：${room}（換房：網址加 ?room=名稱）`;
  const nameInput = $('name') as HTMLInputElement;
  nameInput.value = name;
  nameInput.addEventListener('change', () => {
    name = nameInput.value.trim() || name;
    nameInput.value = name;
    localStorage.setItem('nrz-name', name);
  });

  const client = await createChatClient({
    roomId: room,
    userId: uid,
    identityNamespace: uid,
    signaling: createHttpSignaling(location.origin, { pollMs: 400 }),
    directory: createHttpRoomDirectory(location.origin, room, uid),
  });

  client.onStatus(({ transport, encryption }) => {
    const ready = transport === 'p2p' && encryption === 'ready';
    $('status').textContent = ready ? '已連線（P2P 直連＋端到端加密）' : `連線中…（${transport} / ${encryption}）`;
    $('status').className = ready ? 'ok' : '';
  });

  const list = $('messages');
  const add = (from: string, text: string, mine: boolean) => {
    const div = document.createElement('div');
    div.className = 'msg' + (mine ? ' mine' : '');
    div.innerHTML = `<b>${esc(from)}</b>${esc(text)}`;
    list.appendChild(div);
    list.scrollTop = list.scrollHeight;
  };

  client.onMessage((m) => {
    const { text } = client.decode(m);
    // 名字內嵌在訊息（n|文字），避免額外協議
    const sep = text.indexOf('|');
    const from = sep > 0 ? text.slice(0, sep) : m.from.slice(0, 6);
    add(from, sep > 0 ? text.slice(sep + 1) : text, m.from === client.userId);
  });

  await client.connect();

  const input = $('input') as HTMLInputElement;
  const send = async () => {
    const text = input.value.trim();
    if (!text) return;
    input.value = '';
    try {
      await client.sendMessage(`${name}|${text}`);
    } catch {
      add('系統', '送出失敗（可能金鑰尚未就緒，稍候再試）', false);
    }
  };
  $('send').addEventListener('click', () => void send());
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') void send(); });
  input.disabled = false;
  ($('send') as HTMLButtonElement).disabled = false;
  input.focus();
}

void main().catch((e) => { $('status').textContent = `啟動失敗：${e?.message ?? e}`; });
