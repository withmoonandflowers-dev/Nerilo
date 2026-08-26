/**
 * 本地會合點的 signaling 工廠（Spec 027）：接 `npx nerilo-rendezvous` 起的區網 HTTP 會合點。
 *
 * 目標情境：對外網路斷了，但區域網還在（社區路由器／手機熱點）。任一台裝置跑會合點，
 * 同網段的人以此交換 WebRTC 連線資訊，之後的訊息全走 P2P。
 *
 * 語義鏡像 InMemorySignalingTransport：同房所有 channelLabel 混在一起（消費端過濾）、
 * subscribe 先回放 cutoff 之後的既有再串新增、自己送的也會回到自己的 subscriber。
 * 輪詢制（預設 500ms）：Node 內建 http 沒有 server 端 WebSocket，而 signaling 流量極小，
 * 500ms 的延遲對「建立連線」無感——這讓伺服器與 SDK 都維持零新依賴。
 *
 * 誠實邊界：會合點無認證，同區網任何人可讀寫並加入房間（信任模型＝災難情境的區網；
 * 與離線邀請碼「持碼即可入」一致）。不要把會合點暴露到公網。
 */
import type { SignalingFactory, SignalingTransport, RawSignalDoc } from '../core/p2p/SignalingTransport.types';
import { logger } from '../utils/logger';

interface WireSignal { doc: RawSignalDoc; createdAtMs: number; seq: number }

export function createHttpSignaling(baseUrl: string, opts?: { pollMs?: number }): SignalingFactory {
  const base = baseUrl.replace(/\/$/, '');
  const pollMs = opts?.pollMs ?? 500;

  return (roomId, _channelLabel): SignalingTransport => {
    const roomUrl = `${base}/rooms/${encodeURIComponent(roomId)}/signals`;
    return {
      subscribe(cutoffMs, onAdded) {
        let after = 0;
        let stopped = false;
        const tick = async () => {
          try {
            const res = await fetch(`${roomUrl}?after=${after}`);
            if (!res.ok) return;
            const { signals } = (await res.json()) as { signals: WireSignal[] };
            if (stopped) return;
            for (const s of signals) {
              after = Math.max(after, s.seq);
              if (s.createdAtMs >= cutoffMs) onAdded(s.doc);
            }
          } catch {
            /* 會合點暫時不可達：下輪再試（斷網情境本來就會抖） */
          }
        };
        void tick();
        const timer = setInterval(() => void tick(), pollMs);
        return () => { stopped = true; clearInterval(timer); };
      },
      async send(data) {
        const res = await fetch(roomUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(data),
        });
        if (!res.ok) throw new Error(`rendezvous send failed: ${res.status}`);
      },
      async cleanupOlderThan() {
        // 會合點無刪除 API（無狀態、行程結束即消失）；契約允許 best-effort no-op
        logger.debug?.('[httpSignaling] cleanupOlderThan is a no-op on rendezvous');
      },
      async cleanupOwn() {
        logger.debug?.('[httpSignaling] cleanupOwn is a no-op on rendezvous');
      },
    };
  };
}
