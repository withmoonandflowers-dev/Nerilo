/**
 * MeshGossipManager → GameTransportSDK 接線（M4 傳輸契約）。
 *
 * 遊戲事件成為 gossip 可靠廣播管線的第二個 consumer（第一個是聊天）：
 * 遊戲 envelope 以 JSON 存於 GossipMessage.content、channel:'game' 分流，
 * 沿用同一條「簽章 + (senderId, seq) 去重 + anti-entropy 對帳」管線，
 * 因此在 3–5 人 mesh 上獲得與聊天同等的「最終各恰好一次」保證——
 * 不論送出當下 pairwise 連線是否全就緒（補償，不 gating）。
 *
 * 定向 send：與星型版（P2PBusBroadcast）同語義——廣播 + to 欄位標記，
 * 收端過濾。3–5 人下廣播成本可接受；真正的 peer 定向路由屬後續優化。
 *
 * 適用邊界（見 docs/game/transport-contract-M4.md）：
 * 回合制 / lockstep 事件流。60Hz 即時狀態流不適用此通道
 * （會塞爆 store 與 rate limit），需 realtime-lossy 通道（未實作）。
 */
import type { MeshGossipManager } from '../../mesh/MeshGossipManager';
import type { P2PEnvelope, Envelope, FeatureContext, GossipMessage } from '../../../types';
import type { IGameBroadcast } from './GameTransportSDK';
import { GameFeature } from './GameFeature';
import { logger } from '../../../utils/logger';

export class MeshGossipBroadcast implements IGameBroadcast {
  constructor(private readonly mesh: MeshGossipManager) {}

  async broadcast(envelope: unknown): Promise<void> {
    const env = envelope as P2PEnvelope;
    // messageId = envelope.id：跨路徑（未來若遊戲也走備援橋接）去重的錨點
    await this.mesh.sendMessage(JSON.stringify(env), env.id, 'game');
  }

  async send(peerId: string, envelope: unknown): Promise<void> {
    const env = { ...(envelope as P2PEnvelope), to: peerId };
    await this.mesh.sendMessage(JSON.stringify(env), env.id, 'game');
  }
}

/** GameFeature.setup 需要的最小 FeatureContext（store in-memory、ledger no-op，同星型版） */
function makeMeshGameFeatureContext(
  mesh: MeshGossipManager,
  selfId: string,
  roomId: string
): FeatureContext {
  const mem = new Map<string, unknown>();
  const broadcaster = new MeshGossipBroadcast(mesh);
  return {
    selfId,
    roomId,
    send: async (peerId: string, env: Envelope) => broadcaster.send(peerId, env),
    broadcast: async (env: Envelope) => broadcaster.broadcast(env),
    appendLedger: async () => {
      /* 遊戲流量不進 ledger；點數化屬 ADR-0011 範圍 */
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
 * 把一個 GameTransportSDK 掛上 mesh gossip 管線：
 * outbound 設 MeshGossipBroadcast；inbound 訂閱 gossip 訊息、
 * 只取 channel:'game'、解 JSON、過濾定向（to ≠ 自己則略過）後交
 * GameFeature.handleEnvelope（含 runtime payload 驗證）。回傳卸除函式。
 *
 * 註：mesh.onMessage 不回吐本機送出的訊息（gossip 層設計），
 * 與星型 bus 語義一致——本機輸入由 SDK 的 submitLocalInput 直接入模擬。
 */
export async function attachGameTransportToMesh(
  mesh: MeshGossipManager,
  sdk: {
    setBroadcaster(b: IGameBroadcast): void;
    getFeatureModule(): typeof GameFeature;
  },
  selfId: string,
  roomId: string
): Promise<() => Promise<void>> {
  sdk.setBroadcaster(new MeshGossipBroadcast(mesh));
  const feature = sdk.getFeatureModule(); // 綁定 callbacks → 此 SDK 實例
  await feature.setup(makeMeshGameFeatureContext(mesh, selfId, roomId));

  const unsubscribe = mesh.onMessage((gossip: GossipMessage) => {
    if (gossip.channel !== 'game') return; // 聊天等其他通道不進遊戲

    let env: Envelope;
    try {
      env = JSON.parse(gossip.content) as Envelope;
    } catch {
      logger.warn('[MeshGossipBroadcast] Malformed game envelope ignored', {
        roomId,
        senderId: gossip.senderId,
        seq: gossip.seq,
      });
      return;
    }

    // 定向過濾：帶 to 且不是給自己的略過（廣播 + 收端過濾語義）
    const to = (env as unknown as Record<string, unknown>).to;
    if (typeof to === 'string' && to.length > 0 && to !== selfId) return;

    void feature.handleEnvelope?.(env);
  });

  return async () => {
    unsubscribe();
    await feature.teardown();
  };
}
