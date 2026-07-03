/**
 * P2PChannelBus → GameTransportSDK 接線（ADR-0015）。
 *
 * GameTransportSDK 廣播的 envelope 本來就是 ns:'game' 的 P2PEnvelope 相容
 * 格式，因此 outbound 只是轉送；inbound 訂閱 'game' namespace 後交給
 * GameFeature.handleEnvelope 分發（含 runtime payload 驗證）。
 *
 * 定向 send 在星型（2 人）拓撲下與 broadcast 等價（DataChannel 只有一條）；
 * mesh 的 peer 定向路由屬 M4 傳輸契約工作，在此之前 send 以 to 欄位標記
 * 交由接收端過濾。
 */
import type { P2PChannelBus } from '../../p2p/P2PChannelBus';
import type { P2PEnvelope, Envelope, FeatureContext } from '../../../types';
import type { IGameBroadcast } from './GameTransportSDK';
import { GameFeature } from './GameFeature';
import { logger } from '../../../utils/logger';

export class P2PBusBroadcast implements IGameBroadcast {
  constructor(private readonly bus: P2PChannelBus) {}

  async broadcast(envelope: unknown): Promise<void> {
    await this.bus.send(envelope as P2PEnvelope);
  }

  async send(peerId: string, envelope: unknown): Promise<void> {
    await this.bus.send({ ...(envelope as P2PEnvelope), to: peerId });
  }
}

/** GameFeature.setup 需要的最小 FeatureContext（store 為 in-memory，ledger no-op） */
function makeGameFeatureContext(
  bus: P2PChannelBus,
  selfId: string,
  roomId: string
): FeatureContext {
  const mem = new Map<string, unknown>();
  return {
    selfId,
    roomId,
    send: async (peerId: string, env: Envelope) =>
      bus.send({ ...(env as unknown as P2PEnvelope), to: peerId }),
    broadcast: async (env: Envelope) => bus.send(env as unknown as P2PEnvelope),
    appendLedger: async () => {
      /* 遊戲流量不進 ledger；點數化屬 ADR-0011 M4 範圍 */
    },
    store: {
      get: async (key: string) => mem.get(key),
      set: async (key: string, value: unknown) => {
        mem.set(key, value);
      },
      delete: async (key: string) => {
        mem.delete(key);
      },
    },
    logger: {
      info: (msg, meta) => logger.info(msg, meta),
      warn: (msg, meta) => logger.warn(msg, meta),
      error: (msg, meta) => logger.error(msg, meta),
    },
  };
}

/**
 * 把一個 GameTransportSDK 掛上 P2PChannelBus：
 * setup GameFeature（綁 callbacks 到此 SDK 實例）、outbound 設 broadcaster、
 * inbound 訂閱 'game' namespace。回傳卸除函式。
 */
export async function attachGameTransport(
  bus: P2PChannelBus,
  sdk: {
    setBroadcaster(b: IGameBroadcast): void;
    getFeatureModule(): typeof GameFeature;
  },
  selfId: string,
  roomId: string
): Promise<() => Promise<void>> {
  sdk.setBroadcaster(new P2PBusBroadcast(bus));
  const feature = sdk.getFeatureModule(); // 綁定 callbacks → 此 SDK 實例
  await feature.setup(makeGameFeatureContext(bus, selfId, roomId));
  const unsubscribe = bus.subscribe('game', async (envelope) => {
    await feature.handleEnvelope?.(envelope as unknown as Envelope);
  });
  return async () => {
    unsubscribe();
    await feature.teardown();
  };
}
