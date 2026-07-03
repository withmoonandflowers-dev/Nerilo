/**
 * 連線地球的座標來源（隱私優先，時區近似）。
 *
 * 連線建立後，經 P2PChannelBus 的 'presence' namespace 週期廣播「自己的時區」，
 * 並收集對方的時區 → 近似經緯度。刻意只交換時區字串（區域級、粗略），
 * 不碰 GPS/IP，不動 ChatService（獨立 namespace，零侵入核心協議）。
 */
import { useState, useEffect, useMemo } from 'react';
import type { P2PChannelBus } from '../core/p2p/P2PChannelBus';
import type { P2PEnvelope } from '../types';
import { localTimezone, timezoneToLatLng } from '../utils/geo';
import { generateUUID } from '../utils/uuid';
import type { GlobePoint } from '../components/ConnectionGlobe/ConnectionGlobe';

const PRESENCE_NS = 'presence';
const ANNOUNCE_INTERVAL_MS = 3000;
const ANNOUNCE_WINDOW_MS = 18000;

export function usePeerGlobe(
  channelBus: P2PChannelBus | null,
  connected: boolean,
  selfId: string
): GlobePoint[] {
  const localTz = useMemo(() => localTimezone(), []);
  // from → timezone
  const [peers, setPeers] = useState<Map<string, string>>(new Map());

  useEffect(() => {
    if (!connected || !channelBus) return;

    const unsub = channelBus.subscribe(PRESENCE_NS, (env: P2PEnvelope) => {
      const payload = env.payload as { timezone?: unknown } | undefined;
      const tz = payload?.timezone;
      const from = env.from;
      if (typeof tz === 'string' && typeof from === 'string' && from !== selfId) {
        setPeers((prev) => {
          if (prev.get(from) === tz) return prev;
          const next = new Map(prev);
          next.set(from, tz);
          return next;
        });
      }
    });

    // 週期廣播自己的時區，讓稍晚加入者也收得到（時間窗後停止，避免長期噪音）
    const announce = () => {
      const envelope: P2PEnvelope = {
        v: 1,
        ns: PRESENCE_NS,
        type: 'GEO',
        id: generateUUID(),
        ts: Date.now(),
        from: selfId,
        payload: { timezone: localTz },
      };
      channelBus.send(envelope).catch(() => {
        /* presence 是盡力而為，失敗不影響聊天 */
      });
    };
    announce();
    const interval = setInterval(announce, ANNOUNCE_INTERVAL_MS);
    const stop = setTimeout(() => clearInterval(interval), ANNOUNCE_WINDOW_MS);

    return () => {
      unsub();
      clearInterval(interval);
      clearTimeout(stop);
    };
  }, [connected, channelBus, selfId, localTz]);

  return useMemo(() => {
    const pts: GlobePoint[] = [{ coord: timezoneToLatLng(localTz), self: true }];
    for (const tz of peers.values()) {
      pts.push({ coord: timezoneToLatLng(tz) });
    }
    return pts;
  }, [localTz, peers]);
}
