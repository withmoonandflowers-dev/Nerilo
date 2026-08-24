/**
 * Nerilo reference 整合：最小可跑聊天。
 *
 * 這支檔案示範一個第三方消費者要做的全部事情：
 *   1. import 門面與記憶體 adapter（全來自套件 `nerilo`）。
 *   2. 用 createChatClient 注入四道縫（signaling / directory / storage / userId）。
 *   3. connect() → onMessage 訂閱 → sendMessage 送出。
 *
 * 刻意零 Firebase：同頁兩個 client 共用記憶體 hub，經 WebRTC 直連並端到端加密互傳。
 * 只用公開契約（NeriloClient 門面），不碰任何內部 mesh/crypto 類別。
 */
import {
  InMemorySignalingHub,
  InMemorySignalingTransport,
  InMemoryRoomDirectory,
  InMemoryRoomDirectoryHub,
  InMemoryChatStorage,
  type NeriloClient,
  type NeriloStatus,
} from 'nerilo';
// turnkey 工廠在 subpath（架構收斂 2026-07）
import { createChatClient } from 'nerilo/firestore';

const ROOM = 'demo-room';

// 同一組 hub 給同頁的兩個 client 共用 → 單一 JS context 內即可互通。
const sigHub = new InMemorySignalingHub();
const dirHub = new InMemoryRoomDirectoryHub();

function makeClient(userId: string): Promise<NeriloClient> {
  return createChatClient({
    roomId: ROOM,
    userId,
    signaling: (roomId, channelLabel) => new InMemorySignalingTransport(sigHub, roomId, channelLabel),
    directory: new InMemoryRoomDirectory(dirHub, ROOM, userId),
    storage: new InMemoryChatStorage(),
  });
}

function $(id: string): HTMLElement {
  const el = document.getElementById(id);
  if (!el) throw new Error(`missing #${id}`);
  return el;
}

function setStatus(text: string): void {
  $('status').textContent = text;
}

function append(peer: 'alice' | 'bob', from: string, text: string, self: string): void {
  const row = document.createElement('div');
  row.className = 'msg' + (from === self ? ' mine' : '');
  row.textContent = `${from}: ${text}`;
  const log = $(`log-${peer}`);
  log.appendChild(row);
  log.scrollTop = log.scrollHeight;
}

/**
 * 狀態列（Spec 024）：只用公開 API（client.onStatus）呈現真實轉換
 * 「連線中 → 已連線（P2P）→ 加密就緒」。不猜、不寫死。
 */
const TRANSPORT_TEXT: Record<NeriloStatus['transport'], string> = {
  connecting: '連線中…',
  p2p: 'P2P 直連',
  offline: '離線',
};
const ENCRYPTION_TEXT: Record<NeriloStatus['encryption'], string> = {
  pending: '🔑 金鑰交換中',
  ready: '🔒 E2EE',
  degraded: '⚠️ 未加密',
};

function wireStatus(peer: 'alice' | 'bob', client: NeriloClient): void {
  client.onStatus((s) => {
    $(`e2ee-${peer}`).textContent = `${TRANSPORT_TEXT[s.transport]}・${ENCRYPTION_TEXT[s.encryption]}`;
  });
}

function wireComposer(peer: 'alice' | 'bob', client: NeriloClient): void {
  const input = $(`input-${peer}`) as HTMLInputElement;
  const button = $(`send-${peer}`) as HTMLButtonElement;
  const send = async () => {
    const text = input.value.trim();
    if (!text) return;
    input.value = '';
    await client.sendMessage(text);
  };
  button.addEventListener('click', () => void send());
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') void send(); });
  input.disabled = false;
  button.disabled = false;
}

async function main(): Promise<void> {
  setStatus('建立 client（注入記憶體後端，零 Firebase）…');
  const alice = await makeClient('alice');
  const bob = await makeClient('bob');

  // 先訂閱、再連線，才不會漏掉早到的訊息。每個 client 只認得自己的 userId。
  alice.onMessage((m) => append('alice', m.from, alice.decode(m).text, 'alice'));
  bob.onMessage((m) => append('bob', m.from, bob.decode(m).text, 'bob'));

  // 連線前就掛狀態列：能看到 connecting/pending → p2p/ready 的真實轉換（Spec 024 V1）
  wireStatus('alice', alice);
  wireStatus('bob', bob);

  setStatus('連線中（WebRTC 直連 + ECDH 金鑰交換）…');
  await Promise.all([alice.connect(), bob.connect()]);

  wireComposer('alice', alice);
  wireComposer('bob', bob);
  setStatus(`已連線：alice=${alice.userId ?? '?'}，bob=${bob.userId ?? '?'}。在任一側輸入即可互傳。`);

  // 生命週期：離開頁面時清理連線。
  window.addEventListener('beforeunload', () => { void alice.dispose(); void bob.dispose(); });
}

main().catch((err) => {
  console.error('[nerilo-example] 啟動失敗', err);
  setStatus(`啟動失敗：${err instanceof Error ? err.message : String(err)}`);
});
