/**
 * Spec 025 T5：共享狀態驗證頁。
 * 同頁三 client（各自 identityNamespace——同源多實例必傳，見 Spec 023 實作期發現），
 * InMemory signaling/directory、真 WebRTC、真房金鑰加密。
 * A/B 先進房互寫；C 晚進按鈕加入 → get() 應拿到現況（含刪除生效後的樣子）。
 */
import {
  InMemorySignalingHub,
  InMemorySignalingTransport,
  InMemoryRoomDirectory,
  InMemoryRoomDirectoryHub,
} from 'nerilo';
import { createTransportClient, type NeriloTransportClient, type SharedState } from 'nerilo/transport';

const ROOM = 'shared-state-demo';
const sigHub = new InMemorySignalingHub();
const dirHub = new InMemoryRoomDirectoryHub();

const peersDiv = document.getElementById('peers')!;
const verdict = document.getElementById('verdict')!;

function panel(name: string): HTMLPreElement {
  const div = document.createElement('div');
  div.className = 'peer';
  div.innerHTML = `<h3>${name}</h3><div class="st" id="st-${name}">connecting…</div><pre id="view-${name}">{}</pre>`;
  peersDiv.appendChild(div);
  return div.querySelector('pre')!;
}

async function makePeer(name: string): Promise<{ client: NeriloTransportClient; state: SharedState }> {
  const pre = panel(name);
  const client = await createTransportClient({
    roomId: ROOM,
    userId: name,
    identityNamespace: name, // 同源多實例必傳
    signaling: (r, ch) => new InMemorySignalingTransport(sigHub, r, ch),
    directory: new InMemoryRoomDirectory(dirHub, ROOM, name),
  });
  client.onStatus((s) => {
    document.getElementById(`st-${name}`)!.textContent = `${s.transport} / ${s.encryption}`;
  });
  const state = client.sharedState();
  state.onChange((view) => { pre.textContent = JSON.stringify(view, null, 1); });
  await client.connect();
  return { client, state };
}

declare global {
  interface Window { __peers: Record<string, { client: NeriloTransportClient; state: SharedState }> }
}
window.__peers = {};

async function main(): Promise<void> {
  window.__peers['A'] = await makePeer('A');
  window.__peers['B'] = await makePeer('B');

  let score = 0;
  document.getElementById('btn-a-score')!.addEventListener('click', () => {
    window.__peers['A']!.state.set('score', ++score);
  });
  document.getElementById('btn-b-map')!.addEventListener('click', () => {
    window.__peers['B']!.state.set('map', ['desert', 'forest', 'lava'][score % 3]);
  });
  document.getElementById('btn-a-del')!.addEventListener('click', () => {
    window.__peers['A']!.state.delete('note');
  });
  document.getElementById('btn-c-join')!.addEventListener('click', () => {
    void (async () => {
      window.__peers['C'] = await makePeer('C');
      // 輪詢判定：晚進者收斂含 keyx 產生方交接（同代異鑰窗，Spec 022），可達 20 秒級；35 秒內收斂即 PASS
      const t0 = Date.now();
      const timer = setInterval(() => {
        const a = JSON.stringify(window.__peers['A']!.state.get());
        const c = JSON.stringify(window.__peers['C']!.state.get());
        if (a === c && a !== '{}') {
          clearInterval(timer);
          verdict.className = 'pass';
          verdict.textContent = `PASS：C 晚進補齊成功（${((Date.now() - t0) / 1000).toFixed(1)}s），視圖一致 ${a}`;
        } else if (Date.now() - t0 > 35000) {
          clearInterval(timer);
          verdict.className = 'fail';
          verdict.textContent = `FAIL：A=${a} C=${c}`;
        }
      }, 500);
    })();
  });
}

main().catch((e) => { verdict.className = 'fail'; verdict.textContent = `啟動失敗：${e?.message ?? e}`; });
