/**
 * ADR-0023 P2-②c：keyx 整合模擬（真 RoomKeyCoordinator + 真 GossipMessageHandler + 真 crypto）
 *
 * 不經 WebRTC——以「記憶體內 gossip 傳輸」把多個節點串起來（送出即遞給其他節點的
 * handleReceivedMessage，含轉發與 keyx；(senderId,seq) 去重保證終止）。用以確定性驗證
 * 光靠 mock-dep 單元測不到的「整合行為」：
 *  1. 產生方分發 → 全員消費 keyx → 密文訊息各自解得開（收斂）。
 *  2. 新成員加入 → 產生方遞增 epoch 重發 → 全員（含新人）解得開 epoch-1 訊息。
 *  3. 前向保密：新人補到加入前的 epoch-0 密文 → 開不了（顯示佔位），符合 ADR
 *     「新成員看不到入群前歷史」的隱私特性。
 */
import { describe, it, expect, vi } from 'vitest';
import { GossipMessageHandler } from '../../src/core/mesh/GossipMessageHandler';
import { RoomKeyCoordinator } from '../../src/core/mesh/RoomKeyCoordinator';
import { arrayBufferToBase64 } from '../../src/utils/crypto';
import type { GossipMessage } from '../../src/types';

const ROOM = 'sim-room';

async function ecdhPair(): Promise<CryptoKeyPair> {
  return crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, [
    'deriveBits',
    'deriveKey',
  ]) as Promise<CryptoKeyPair>;
}
async function spkiB64(k: CryptoKey): Promise<string> {
  return arrayBufferToBase64(await crypto.subtle.exportKey('spki', k));
}

/** 記憶體內 gossip 網：節點送出的訊息遞給其他所有節點；含轉發，(senderId,seq) 去重終止 */
class SimNetwork {
  private queue: Array<{ from: string; msg: GossipMessage }> = [];
  readonly nodes = new Map<string, SimNode>();
  /** 攔截所有送出的「聊天/keyx」wire（供事後取歷史密文餵新人） */
  readonly sentWires: GossipMessage[] = [];

  enqueue(from: string, msg: GossipMessage): void {
    this.sentWires.push(msg);
    this.queue.push({ from, msg });
  }

  /** 遞送直到靜止（去重使轉發收斂）。每則遞給除寄件者外的所有節點。 */
  async flush(): Promise<void> {
    let guard = 0;
    while (this.queue.length > 0) {
      if (++guard > 10_000) throw new Error('sim flush did not converge');
      const { from, msg } = this.queue.shift()!;
      for (const [id, node] of this.nodes) {
        if (id === from) continue;
        await node.handler.handleReceivedMessage(structuredClone(msg), from);
      }
    }
  }
}

class SimNode {
  handler!: GossipMessageHandler;
  coord!: RoomKeyCoordinator;
  displayed: string[] = [];

  private constructor(
    readonly userId: string,
    readonly ecdh: CryptoKeyPair,
    readonly ecdhPubB64: string
  ) {}

  static async create(
    userId: string,
    net: SimNetwork,
    roster: () => { members: Array<{ userId: string; ecdhPubKey?: string }>; participantCount: number }
  ): Promise<SimNode> {
    const ecdh = await ecdhPair();
    const node = new SimNode(userId, ecdh, await spkiB64(ecdh.publicKey));

    // 單一「代表所有鄰居」的連線 mock：send 把 wire 丟進網路佇列
    const neighbor = {
      getId: vi.fn().mockReturnValue(`net-${userId}`),
      getState: vi.fn().mockReturnValue('connected'),
      send: vi.fn().mockImplementation((m: GossipMessage) => {
        net.enqueue(userId, m);
        return Promise.resolve();
      }),
      sendDigest: vi.fn().mockResolvedValue(undefined),
    };
    // identity/security mock：pubKey 直接是 userId → 驗簽（mock true）與 senderId 對齊自洽
    const identity = {
      exportPublicKey: vi.fn().mockResolvedValue(userId),
      getPrivateKey: vi.fn().mockReturnValue({} as CryptoKey),
      deriveUserId: vi.fn().mockImplementation((k: string) => Promise.resolve(k)),
    };
    const security = {
      signMessage: vi.fn().mockResolvedValue('sig'),
      importPublicKey: vi.fn().mockImplementation((pk: string) => Promise.resolve(pk)),
      verifyMessage: vi.fn().mockResolvedValue(true),
    };
    const topology = {
      getNeighbors: vi.fn().mockReturnValue([neighbor]),
      getGossipConfig: vi.fn().mockReturnValue({ fanout: 5, ttl: 8 }),
    };

    node.handler = new GossipMessageHandler(
      ROOM, userId, identity as never, security as never, topology as never
    );
    node.handler.setKeyxPrivateKey(ecdh.privateKey);
    node.handler.onMessage((m) => node.displayed.push(m.content));

    node.coord = new RoomKeyCoordinator({
      localUserId: userId,
      getEcdhPrivateKey: () => ecdh.privateKey,
      getEcdhPublicKeyBase64: () => Promise.resolve(node.ecdhPubB64),
      loadRoster: () => Promise.resolve(roster()),
      sendKeyx: (content) => node.handler.sendMessage(content, undefined, 'keyx'),
      applyLocalKey: (key, epoch) => node.handler.setContentKey(key, epoch),
      getMaxKnownEpoch: () => node.handler.getMaxKnownEpoch(),
    });

    net.nodes.set(userId, node);
    return node;
  }
}

/** 反覆 tick 所有協調器並遞送，直到某條件成立（穩定窗需跨數輪累積） */
async function settle(
  net: SimNetwork,
  nodes: SimNode[],
  done: () => boolean,
  maxRounds = 12
): Promise<void> {
  for (let i = 0; i < maxRounds; i++) {
    for (const n of nodes) await n.coord.tick();
    await net.flush();
    if (done()) return;
  }
}

describe('P2-②c keyx 整合模擬（真協調器 + 真 handler + 真 crypto）', () => {
  it('3 人分發→收斂；加人→epoch 遞增全員解得開；新人開不了加入前歷史（前向保密）', async () => {
    const net = new SimNetwork();
    // 名冊為可變共享狀態；userId 前綴保證產生方（字典序最小）確定
    let roster = {
      members: [] as Array<{ userId: string; ecdhPubKey?: string }>,
      participantCount: 0,
    };
    const rosterFn = () => roster;

    const a = await SimNode.create('n1-alice', net, rosterFn);
    const b = await SimNode.create('n2-bob', net, rosterFn);
    const c = await SimNode.create('n3-carol', net, rosterFn);
    const abc = [a, b, c];
    roster = {
      members: abc.map((n) => ({ userId: n.userId, ecdhPubKey: n.ecdhPubB64 })),
      participantCount: 3,
    };

    // ── 階段 1：3 人分發 + 收斂 ───────────────────────────────────────────────
    await settle(net, abc, () => abc.every((n) => n.handler.getMaxKnownEpoch() === 0));
    expect(abc.every((n) => n.handler.getMaxKnownEpoch() === 0)).toBe(true);

    // alice 送 epoch-0 密文；bob/carol 應顯示明文
    const before = net.sentWires.length;
    await a.handler.sendMessage('epoch0-hello', 'm0');
    await net.flush();
    const epoch0Wire = net.sentWires
      .slice(before)
      .find((w) => (w.channel ?? 'chat') === 'chat')!;
    expect(epoch0Wire.content).toContain('"v":"nrec1"'); // wire 是密文
    expect(b.displayed).toContain('epoch0-hello');
    expect(c.displayed).toContain('epoch0-hello');

    // ── 階段 2：dave 加入 → 名冊變動 → 產生方遞增 epoch 重發 ──────────────────
    const d = await SimNode.create('n4-dave', net, rosterFn);
    const abcd = [a, b, c, d];
    roster = {
      members: abcd.map((n) => ({ userId: n.userId, ecdhPubKey: n.ecdhPubB64 })),
      participantCount: 4,
    };

    await settle(net, abcd, () => abcd.every((n) => n.handler.getMaxKnownEpoch() === 1));
    expect(abcd.every((n) => n.handler.getMaxKnownEpoch() === 1)).toBe(true);

    // dave 送 epoch-1 密文；全員（含 dave 自送不回吐，驗 a/b/c）解得開
    await d.handler.sendMessage('epoch1-hi', 'm1');
    await net.flush();
    for (const n of [a, b, c]) expect(n.displayed).toContain('epoch1-hi');

    // ── 階段 3：前向保密——把 alice 的 epoch-0 密文餵給 dave → 開不了（佔位）──────
    d.displayed.length = 0;
    await d.handler.handleReceivedMessage(structuredClone(epoch0Wire), 'n1-alice');
    expect(d.displayed).toHaveLength(1);
    expect(d.displayed[0]).toContain('🔒'); // 新人無 epoch-0 金鑰 → 佔位
    expect(d.displayed[0]).not.toContain('epoch0-hello'); // 讀不到入群前內容
  });
});
