/**
 * 遊戲傳輸 mesh 接線證明（M4 傳輸契約）
 *
 * 驗證 GameTransportSDK 能騎在 mesh gossip 可靠廣播管線上收發遊戲資料：
 *  - outbound：submitLocalInput → mesh.sendMessage(content=game envelope JSON,
 *    messageId=envelope.id, channel:'game')
 *  - inbound：channel:'game' 的 gossip 訊息 → 解 JSON → GameFeature 驗證分發
 *    → SDK 內部狀態更新（輸入進 buffer）
 *  - 通道分流：chat 通道訊息不進遊戲；定向（to ≠ 自己）略過；壞 JSON 靜默忽略
 *
 * 註：GameFeature 是模組級單例（每 runtime 一個 SDK），本測試以
 * 「單活體 SDK + 手工構造對端 gossip 訊息」驗證，與 GameTransportWiring.spec 同款。
 *
 * @vitest-environment node
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { GameTransportSDK } from '../../src/core/game/sdk/GameTransportSDK';
import { attachGameTransportToMesh } from '../../src/core/game/sdk/MeshGossipBroadcast';
import { GameMsgType } from '../../src/core/game/sdk/GameMessageTypes';
import type { GossipMessage, P2PEnvelope } from '../../src/types';

/** 最小 MeshGossipManager 形狀：紀錄 outbound、可模擬 inbound gossip */
class MockMeshGossipManager {
  sent: Array<{ content: string; messageId?: string; channel?: string }> = [];
  private listeners = new Set<(m: GossipMessage) => void>();

  async sendMessage(content: string, messageId?: string, channel?: string): Promise<void> {
    this.sent.push({ content, messageId, channel });
  }

  onMessage(listener: (m: GossipMessage) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  simulateGossip(partial: Partial<GossipMessage>): void {
    const msg = {
      roomId: 'room-game-1',
      senderId: 'mesh-user-remote',
      pubKey: 'pk',
      seq: 1,
      timestamp: Date.now(),
      content: '',
      ttl: 1,
      signature: 'sig',
      ...partial,
    } as GossipMessage;
    this.listeners.forEach((l) => l(msg));
  }
}

function gameEnvelope(type: string, from: string, payload: unknown, to?: string): P2PEnvelope {
  return {
    v: 1,
    ns: 'game',
    type,
    id: `env-${Math.random().toString(36).slice(2)}`,
    ts: Date.now(),
    from,
    ...(to !== undefined ? { to } : {}),
    payload,
  } as P2PEnvelope;
}

function inputEnvelope(from: string, tick: number, to?: string): P2PEnvelope {
  return gameEnvelope(
    GameMsgType.INPUT,
    from,
    { peerId: from, tick, actions: ['fire'], axes: {}, seq: 0 },
    to
  );
}

function getInputsForTick(sdk: GameTransportSDK, tick: number): Map<string, unknown> {
  return (
    sdk as unknown as { inputBuffer: { getInputsForTick(t: number): Map<string, unknown> } }
  ).inputBuffer.getInputsForTick(tick);
}

describe('Game transport wiring over mesh gossip (M4)', () => {
  let mesh: MockMeshGossipManager;
  let sdk: GameTransportSDK;
  let detach: (() => Promise<void>) | null = null;

  beforeEach(async () => {
    mesh = new MockMeshGossipManager();
    sdk = new GameTransportSDK({ localPeerId: 'peer-bob' });
    detach = await attachGameTransportToMesh(
      mesh as unknown as never,
      sdk,
      'peer-bob',
      'room-game-1'
    );
  });

  afterEach(async () => {
    sdk.stop();
    await detach?.();
    detach = null;
  });

  it('outbound: submitLocalInput → mesh.sendMessage 帶 channel game 與 envelope JSON', async () => {
    sdk.submitLocalInput(['move-up'], { x: 0.5 });
    await new Promise((r) => setTimeout(r, 10));

    expect(mesh.sent).toHaveLength(1);
    const sent = mesh.sent[0]!;
    expect(sent.channel).toBe('game');

    const env = JSON.parse(sent.content) as P2PEnvelope;
    expect(env.ns).toBe('game');
    expect(env.type).toBe(GameMsgType.INPUT);
    // messageId 錨定 envelope.id（跨傳輸路徑去重的一致錨點）
    expect(sent.messageId).toBe(env.id);
    const payload = env.payload as { peerId: string; actions: string[] };
    expect(payload.peerId).toBe('peer-bob');
    expect(payload.actions).toEqual(['move-up']);
  });

  it('inbound: channel game 的遠端 INPUT 進 input buffer', async () => {
    const tick = sdk.getCurrentTick() + 1;
    mesh.simulateGossip({
      channel: 'game',
      content: JSON.stringify(inputEnvelope('peer-alice', tick)),
    });
    await new Promise((r) => setTimeout(r, 10));

    const inputs = getInputsForTick(sdk, tick);
    expect(inputs.has('peer-alice')).toBe(true);
  });

  it('通道分流：chat 通道（缺 channel 欄位）不進遊戲', async () => {
    const tick = sdk.getCurrentTick() + 1;
    // 同樣是合法遊戲 envelope JSON，但走 chat 通道（聊天訊息內容恰為 JSON 的情境）
    mesh.simulateGossip({
      content: JSON.stringify(inputEnvelope('peer-alice', tick)),
    });
    await new Promise((r) => setTimeout(r, 10));

    expect(getInputsForTick(sdk, tick).has('peer-alice')).toBe(false);
  });

  it('定向過濾：to 不是自己 → 略過；to 是自己 → 分發', async () => {
    const tick = sdk.getCurrentTick() + 1;
    mesh.simulateGossip({
      channel: 'game',
      content: JSON.stringify(inputEnvelope('peer-alice', tick, 'peer-carol')),
    });
    mesh.simulateGossip({
      channel: 'game',
      seq: 2,
      content: JSON.stringify(inputEnvelope('peer-dave', tick, 'peer-bob')),
    });
    await new Promise((r) => setTimeout(r, 10));

    const inputs = getInputsForTick(sdk, tick);
    expect(inputs.has('peer-alice')).toBe(false); // 給 carol 的
    expect(inputs.has('peer-dave')).toBe(true); // 給自己的
  });

  it('壞 JSON 靜默忽略、不拋錯', async () => {
    expect(() =>
      mesh.simulateGossip({ channel: 'game', content: '{not-json' })
    ).not.toThrow();
  });
});
