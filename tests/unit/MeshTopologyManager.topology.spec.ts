/**
 * MeshTopologyManager 拓撲政策單元測試（Spec 011）
 *
 * 覆蓋：
 * - characterization：建構預設（full-mesh、k=6、fanout 5/ttl 1）＝接線前的產品現況
 * - ≤6 人呼叫 updateParticipantCount 不改變預設（既有 2-5 人基線行為不變）
 * - 第 7 人切 partial-mesh（k=3、fanout 3/ttl 3）；7→10 同 rank 內 k 單調升到 4
 * - 只升不降：人數回降（或名冊快照低報）不降級、不縮 k
 * - accept-slack（R-a）：reactive discovery 對新成員放寬到 k+2，且有上界
 *
 * @vitest-environment node
 */
import { describe, it, expect, vi, afterEach } from 'vitest';

// MeshConnection 換成假物件：不碰 WebRTC/signaling，只記錄建立數量。
// waitForReady 永遠 pending——連線既不成功也不失敗，neighbors 保持穩定可斷言。
vi.mock('../../src/core/mesh/MeshConnection', () => {
  class FakeMeshConnection {
    static instances: FakeMeshConnection[] = [];
    constructor(
      public roomId: string,
      public localUid: string,
      public remoteUid: string,
      public userId: string,
      public isInitiator: boolean
    ) {
      FakeMeshConnection.instances.push(this);
    }
    waitForReady(): Promise<void> {
      return new Promise(() => {});
    }
    async close(): Promise<void> {}
    getState(): string {
      return 'connected';
    }
    getId(): string {
      return this.userId;
    }
  }
  return { MeshConnection: FakeMeshConnection, REJOIN_READY_TIMEOUT_MS: 12_000 };
});

import { MeshTopologyManager } from '../../src/core/mesh/MeshTopologyManager';
import type { IRoomDirectory } from '../../src/ports/IRoomDirectory';

type Identity = { userId: string; pubKey: string; joinedAt: number };

/** 名冊樁：getSnapshot + watchIdentities（push 可手動觸發） */
function makeDirectory(initial: Record<string, Identity> = {}) {
  let watchCb: ((snap: { meshIdentities: Record<string, Identity>; participants: string[] }) => void) | null = null;
  const state = { identities: { ...initial } };
  const dir = {
    getSnapshot: async () => ({
      meshIdentities: state.identities,
      participants: Object.keys(state.identities),
    }),
    watchIdentities: (cb: typeof watchCb) => {
      watchCb = cb;
      return () => {
        watchCb = null;
      };
    },
    registerIdentity: async () => {},
  } as unknown as IRoomDirectory;
  return {
    dir,
    push(identities: Record<string, Identity>) {
      state.identities = identities;
      watchCb?.({ meshIdentities: identities, participants: Object.keys(identities) });
    },
  };
}

function identities(n: number): Record<string, Identity> {
  const out: Record<string, Identity> = {};
  for (let i = 1; i <= n; i++) {
    out[`uid-${String(i).padStart(2, '0')}`] = {
      userId: `user-${String(i).padStart(2, '0')}`,
      pubKey: 'pk',
      joinedAt: 1000 + i,
    };
  }
  return out;
}

function makeManager(dir: IRoomDirectory): MeshTopologyManager {
  // localUserId 取字典序最小，讓本端對所有 pair 當發起方（測試單純化）
  return new MeshTopologyManager('room-topo', 'user-00', 'uid-00', dir);
}

describe('MeshTopologyManager 拓撲政策（Spec 011）', () => {
  const managers: MeshTopologyManager[] = [];

  afterEach(async () => {
    for (const m of managers.splice(0)) await m.cleanup();
    vi.restoreAllMocks();
  });

  it('characterization：建構預設 = full-mesh、k=6、fanout 5/ttl 1（接線前產品現況）', () => {
    const { dir } = makeDirectory();
    const m = makeManager(dir);
    managers.push(m);
    expect(m.getStrategy()).toBe('full-mesh');
    expect(m.getTargetNeighborCount()).toBe(6);
    expect(m.getGossipConfig()).toEqual({ fanout: 5, ttl: 1 });
  });

  it('≤6 人：updateParticipantCount 不改變預設（2-5 人既有基線行為不變）', () => {
    const { dir } = makeDirectory();
    const m = makeManager(dir);
    managers.push(m);
    for (const n of [2, 3, 5, 6]) {
      m.updateParticipantCount(n);
      expect(m.getStrategy()).toBe('full-mesh');
      expect(m.getTargetNeighborCount()).toBe(6);
      expect(m.getGossipConfig()).toEqual({ fanout: 5, ttl: 1 });
    }
  });

  it('第 7 人切 partial-mesh：k=3、fanout 3/ttl 3', () => {
    const { dir } = makeDirectory();
    const m = makeManager(dir);
    managers.push(m);
    m.updateParticipantCount(7);
    expect(m.getStrategy()).toBe('partial-mesh');
    expect(m.getTargetNeighborCount()).toBe(3);
    expect(m.getGossipConfig()).toEqual({ fanout: 3, ttl: 3 });
  });

  it('partial 區間內單調：7→10 人 k 升到 4，不縮', () => {
    const { dir } = makeDirectory();
    const m = makeManager(dir);
    managers.push(m);
    m.updateParticipantCount(7);
    m.updateParticipantCount(10);
    expect(m.getStrategy()).toBe('partial-mesh');
    expect(m.getTargetNeighborCount()).toBe(4);
    m.updateParticipantCount(8); // 區間內回降 → k 不縮
    expect(m.getTargetNeighborCount()).toBe(4);
  });

  it('只升不降：人數回降（含名冊快照低報）不降級', () => {
    const { dir } = makeDirectory();
    const m = makeManager(dir);
    managers.push(m);
    m.updateParticipantCount(7);
    m.updateParticipantCount(3); // 低報/離場 → 不得降回 full-mesh
    expect(m.getStrategy()).toBe('partial-mesh');
    expect(m.getTargetNeighborCount()).toBe(3);
    expect(m.getGossipConfig()).toEqual({ fanout: 3, ttl: 3 });
  });

  it('accept-slack（R-a）：新成員放寬到 k+2 且有上界', async () => {
    const { dir, push } = makeDirectory();
    const m = makeManager(dir);
    managers.push(m);
    await m.initialize(); // 空名冊：無初始連線；掛上 watch
    m.updateParticipantCount(9); // partial：k=3 → acceptLimit=5

    const flush = () => new Promise((r) => setTimeout(r, 0)); // 讓逐一 await 的連線迴圈跑完

    push(identities(8)); // 8 個新成員同時可見
    await flush();
    // 嚴格 k=3 會拒收第 4 條起的新連線（對側 offer 無人接）；slack 放寬到 5
    expect(m.getNeighborCount()).toBe(5);

    push(identities(9)); // 第 9 人到場：已達 acceptLimit → 不再擴
    await flush();
    expect(m.getNeighborCount()).toBe(5);
  });
});
