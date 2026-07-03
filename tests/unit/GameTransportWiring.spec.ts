/**
 * 遊戲傳輸接線證明（ADR-0015）
 *
 * 驗證 GameTransportSDK 能騎在 P2PChannelBus 形狀的傳輸上收發遊戲資料：
 *  - outbound：submitLocalInput → bus 收到格式正確的 ns:'game' envelope
 *  - inbound：對端的 INPUT / SESSION_JOIN envelope 經 attachGameTransport
 *    → GameFeature 驗證分發 → SDK 內部狀態更新（輸入進 buffer、peer 事件）
 *  - 惡意 payload 被 GameFeature 的 runtime 驗證擋下
 *
 * 註：GameFeature 是模組級單例（每個 runtime 一個 SDK，符合瀏覽器分頁模型），
 * 因此本測試以「單活體 SDK + 手工構造對端 envelope」驗證，不在同 process
 * 開兩個 SDK。
 *
 * @vitest-environment node
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { GameTransportSDK } from '../../src/core/game/sdk/GameTransportSDK';
import { attachGameTransport } from '../../src/core/game/sdk/P2PBusBroadcast';
import { GameMsgType } from '../../src/core/game/sdk/GameMessageTypes';
import type { P2PEnvelope } from '../../src/types';

// 與 ChatServiceE2EE.spec 同款的 mock bus
class MockChannelBus {
  private handlers: Map<string, Set<(env: P2PEnvelope) => Promise<void>>> = new Map();
  sent: P2PEnvelope[] = [];

  subscribe(ns: string, handler: (env: P2PEnvelope) => Promise<void>): () => void {
    if (!this.handlers.has(ns)) this.handlers.set(ns, new Set());
    this.handlers.get(ns)!.add(handler);
    return () => this.handlers.get(ns)?.delete(handler);
  }

  async send(envelope: P2PEnvelope): Promise<void> {
    this.sent.push(envelope);
  }

  async simulateReceive(envelope: P2PEnvelope): Promise<void> {
    const handlers = this.handlers.get(envelope.ns) || new Set();
    for (const h of handlers) await h(envelope);
  }

  getSentByType(type: string): P2PEnvelope[] {
    return this.sent.filter((e) => e.type === type);
  }
}

function gameEnvelope(type: string, from: string, payload: unknown): P2PEnvelope {
  return {
    v: 1,
    ns: 'game',
    type,
    id: `env-${Math.random().toString(36).slice(2)}`,
    ts: Date.now(),
    from,
    payload,
  } as P2PEnvelope;
}

describe('Game transport wiring over P2PChannelBus (ADR-0015)', () => {
  let bus: MockChannelBus;
  let sdk: GameTransportSDK;
  let detach: (() => Promise<void>) | null = null;

  beforeEach(async () => {
    bus = new MockChannelBus();
    sdk = new GameTransportSDK({ localPeerId: 'peer-bob' });
    detach = await attachGameTransport(
      bus as unknown as never,
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

  it('outbound: submitLocalInput broadcasts a well-formed game INPUT envelope', async () => {
    sdk.submitLocalInput(['move-up'], { x: 0.5 });
    // broadcaster.broadcast 是 fire-and-forget，等 microtask 清空
    await new Promise((r) => setTimeout(r, 10));

    const sent = bus.getSentByType(GameMsgType.INPUT);
    expect(sent).toHaveLength(1);
    expect(sent[0].ns).toBe('game');
    const payload = sent[0].payload as { peerId: string; actions: string[]; tick: number };
    expect(payload.peerId).toBe('peer-bob');
    expect(payload.actions).toEqual(['move-up']);
    expect(typeof payload.tick).toBe('number');
  });

  it('inbound: remote INPUT envelope lands in the input buffer for its tick', async () => {
    const tick = sdk.getCurrentTick() + 1;
    await bus.simulateReceive(
      gameEnvelope(GameMsgType.INPUT, 'peer-alice', {
        peerId: 'peer-alice',
        tick,
        actions: ['fire'],
        axes: {},
        seq: 0,
      })
    );

    const inputs = (sdk as unknown as { inputBuffer: { getInputsForTick(t: number): Map<string, unknown> } })
      .inputBuffer.getInputsForTick(tick);
    expect(inputs.has('peer-alice')).toBe(true);
    expect((inputs.get('peer-alice') as { actions: string[] }).actions).toEqual(['fire']);
  });

  it('inbound: SESSION_JOIN adds the peer and emits peer:joined', async () => {
    await sdk.createSession({ maxPlayers: 4, gameVersion: '1.0.0', sessionId: 'room-game-1' });

    const joined: string[] = [];
    sdk.on('peer:joined', (id) => joined.push(id as string));

    await bus.simulateReceive(
      gameEnvelope(GameMsgType.SESSION_JOIN, 'peer-alice', {
        peerId: 'peer-alice',
        displayName: 'Alice',
        gameVersion: '1.0.0',
      })
    );

    expect(joined).toContain('peer-alice');
    const peers = sdk.getSession()!.getPeers();
    expect(peers.some((p) => p.peerId === 'peer-alice')).toBe(true);
  });

  it('security: malformed INPUT payload is rejected by runtime validation', async () => {
    const tick = sdk.getCurrentTick() + 1;
    await bus.simulateReceive(
      gameEnvelope(GameMsgType.INPUT, 'peer-evil', {
        peerId: 'peer-evil',
        tick: 'not-a-number', // 型別攻擊
        actions: 'not-an-array',
      })
    );

    const inputs = (sdk as unknown as { inputBuffer: { getInputsForTick(t: number): Map<string, unknown> } })
      .inputBuffer.getInputsForTick(tick);
    expect(inputs.has('peer-evil')).toBe(false);
  });
});
