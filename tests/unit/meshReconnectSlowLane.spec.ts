/**
 * Spec 019：重連慢車道——快車道耗盡不再永久放棄。
 *
 * 修前行為：5 次指數退避耗盡即 give up，靜態房間裡互選邊永久缺席 → 分島
 * （CI 7p R3 實證）。本 spec 用假 timer 直接鎖住三性質：
 * (a) 耗盡後仍有慢車道（~30s）持續重試；
 * (b) 對方已不在確定性互選目標集（以當下 snapshot 計）→ 出列停止；
 * (c) 重試成功 → 成為鄰居（快車道歸零由既有 ready 路徑保證）。
 * 快車道 5 次的節奏維持 characterization（(a) 的前 5 輪即是）。
 *
 * @vitest-environment node
 */
import { describe, it, expect, vi, afterEach } from 'vitest';

// MeshConnection 假物件：預設 waitForReady 拒絕（驅動重試循環）；
// 設 succeedFrom 後，第 N 個實例起改為成功。
vi.mock('../../src/core/mesh/MeshConnection', () => {
  class FakeMeshConnection {
    static instances: FakeMeshConnection[] = [];
    static succeedFrom = Number.POSITIVE_INFINITY;
    static reset() {
      FakeMeshConnection.instances = [];
      FakeMeshConnection.succeedFrom = Number.POSITIVE_INFINITY;
    }
    readonly index: number;
    constructor(
      public roomId: string,
      public localUid: string,
      public remoteUid: string,
      public userId: string,
      public isInitiator: boolean
    ) {
      FakeMeshConnection.instances.push(this);
      this.index = FakeMeshConnection.instances.length;
    }
    waitForReady(): Promise<void> {
      return this.index >= FakeMeshConnection.succeedFrom
        ? Promise.resolve()
        : Promise.reject(new Error('fake: not ready'));
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
import { MeshConnection } from '../../src/core/mesh/MeshConnection';
import type { IRoomDirectory } from '../../src/ports/IRoomDirectory';

const Fake = MeshConnection as unknown as {
  instances: unknown[];
  succeedFrom: number;
  reset(): void;
};

type Identity = { userId: string; pubKey: string; joinedAt: number };

function makeDirectory(initial: Record<string, Identity>) {
  const state = { identities: { ...initial } };
  const dir = {
    getSnapshot: async () => ({
      meshIdentities: state.identities,
      participants: Object.keys(state.identities),
    }),
    watchIdentities: () => () => {},
    registerIdentity: async () => {},
  } as unknown as IRoomDirectory;
  return {
    dir,
    setIdentities(identities: Record<string, Identity>) {
      state.identities = identities;
    },
  };
}

const PEER: Record<string, Identity> = {
  'uid-01': { userId: 'user-01', pubKey: 'pk', joinedAt: 1001 },
};

/** 推進假時鐘並讓非同步鏈（timer 回呼內 await）跑完 */
async function advance(ms: number): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms);
}

describe('Spec 019：重連慢車道', () => {
  const managers: MeshTopologyManager[] = [];

  afterEach(async () => {
    for (const m of managers.splice(0)) await m.cleanup();
    Fake.reset();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  async function boot(dir: IRoomDirectory): Promise<MeshTopologyManager> {
    const m = new MeshTopologyManager('room-slow', 'user-00', 'uid-00', dir);
    managers.push(m);
    await m.initialize(); // 立即發起對 user-01 的連線（失敗 → 進重試迴圈）
    return m;
  }

  it('(a) 快車道 5 次耗盡後降慢車道：20s 內無新嘗試、35s 內有（修前此後永無）', async () => {
    vi.useFakeTimers();
    const { dir } = makeDirectory(PEER);
    await boot(dir);
    await advance(0); // flush 首次失敗

    // 快車道總長 = 1+2+4+8+16s（±10%）∈ [27.9, 34.1]s。推進 36s 涵蓋全部快車道；
    // 最後一次失敗落在 Tf ≤ 34.1s，慢車道首發 ∈ [Tf+27, Tf+33] ⊆ [54.9, 67.1]s 絕對時間。
    await advance(36_000);
    const afterFastLane = Fake.instances.length;
    expect(afterFastLane).toBe(6); // 首次 + 5 次快車道重試（characterization）

    // 50s 絕對時間 < 慢車道下界 54.9s → 無新嘗試（也證明快車道確實已耗盡）
    await advance(14_000);
    expect(Fake.instances.length).toBe(afterFastLane);
    // 推進到 68s > 上界 67.1s → 慢車道真的重試了（修前：永無第 7 個實例）
    await advance(18_000);
    expect(Fake.instances.length).toBe(afterFastLane + 1);
    // 再一輪慢車道（+35s > 33s 上界），確認是持續性而非一次性
    await advance(35_000);
    expect(Fake.instances.length).toBe(afterFastLane + 2);
  });

  it('(b) 對方離開（不在當下 snapshot 的互選目標集）→ 慢車道出列停止', async () => {
    vi.useFakeTimers();
    const { dir, setIdentities } = makeDirectory(PEER);
    await boot(dir);
    await advance(0);
    for (let i = 0; i < 5; i++) await advance(20_000); // 耗盡快車道
    const exhausted = Fake.instances.length;

    setIdentities({}); // 對方離開：snapshot 不再有 user-01
    await advance(35_000); // 慢車道觸發 → 目標集檢查 → 出列
    expect(Fake.instances.length).toBe(exhausted); // 不再建新連線
    await advance(70_000); // 出列是永久的（計數已清、無計時器）
    expect(Fake.instances.length).toBe(exhausted);
  });

  it('(c) 慢車道重試成功 → 成為鄰居，迴圈停止', async () => {
    vi.useFakeTimers();
    const { dir } = makeDirectory(PEER);
    const m = await boot(dir);
    await advance(0);
    for (let i = 0; i < 5; i++) await advance(20_000);
    const exhausted = Fake.instances.length;

    Fake.succeedFrom = exhausted + 1; // 下一個實例起成功
    await advance(35_000);
    expect(Fake.instances.length).toBe(exhausted + 1);
    expect(m.getNeighborCount()).toBe(1); // 連上了
    await advance(70_000); // 成功後不再重試
    expect(Fake.instances.length).toBe(exhausted + 1);
  });
});
