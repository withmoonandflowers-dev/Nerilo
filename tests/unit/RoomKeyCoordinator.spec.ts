/**
 * ADR-0023 P2-②c：RoomKeyCoordinator — 產生方側編排
 * - 產生方（完整穩定名冊中 userId 字典序最小者）分發 keyx；封給所有其他成員、安裝本機金鑰
 * - 三道閘門：全員 ecdh 就緒（eligible==participants）＋名冊連續穩定＋完整名冊最小者
 * - 冪等：穩定名冊只分發一次；名冊變動才重發（epoch = 已知最高+1）
 * - 非產生方 / 名冊<2 / 自己未在名冊 / participant 未全就緒 → no-op（無鑰退明文相容）
 * - 密碼學鏈：分發的 keyx 內，成員以自己的 ECDH 私鑰開得出「與本機安裝的同一把」金鑰
 */
import { describe, it, expect, vi } from 'vitest';
import { RoomKeyCoordinator, rosterFromRoom } from '../../src/core/mesh/RoomKeyCoordinator';
import type { RoomKeyCoordinatorDeps } from '../../src/core/mesh/RoomKeyCoordinator';
import { openSealedRoomKey } from '../../src/core/mesh/RoomKeyDistribution';
import { encryptRecordContent, decryptRecordContent } from '../../src/core/mesh/RecordCrypto';
import { arrayBufferToBase64 } from '../../src/utils/crypto';
import type { KeyxRecordPayload } from '../../src/types';

async function ecdhPair(): Promise<CryptoKeyPair> {
  return crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, [
    'deriveBits',
    'deriveKey',
  ]) as Promise<CryptoKeyPair>;
}
async function spkiB64(k: CryptoKey): Promise<string> {
  return arrayBufferToBase64(await crypto.subtle.exportKey('spki', k));
}

type Roster = { members: Array<{ userId: string; ecdhPubKey?: string }>; participantCount: number };

/** 建一個以 alice 為本機（產生方候選）的協調器，roster 由 loadRoster spy 控制 */
async function setup(opts?: {
  localUserId?: string;
  hasForeignRecords?: () => boolean;
  getMaxObservedEpoch?: () => number;
}) {
  const alice = await ecdhPair();
  const localUserId = opts?.localUserId ?? 'a-user';
  const sendKeyx = vi.fn().mockResolvedValue(undefined);
  const applyLocalKey = vi.fn<(key: CryptoKey, epoch: number) => void>();
  const loadRoster = vi.fn<() => Promise<Roster>>();
  let maxEpoch = -1;
  const deps: RoomKeyCoordinatorDeps = {
    localUserId,
    getEcdhPrivateKey: () => alice.privateKey,
    getEcdhPublicKeyBase64: () => spkiB64(alice.publicKey),
    loadRoster,
    sendKeyx,
    applyLocalKey: (key, epoch) => {
      maxEpoch = Math.max(maxEpoch, epoch);
      applyLocalKey(key, epoch);
    },
    getMaxKnownEpoch: () => maxEpoch,
    ...(opts?.hasForeignRecords ? { hasForeignRecords: opts.hasForeignRecords } : {}),
    ...(opts?.getMaxObservedEpoch ? { getMaxObservedEpoch: opts.getMaxObservedEpoch } : {}),
  };
  return {
    alice,
    coord: new RoomKeyCoordinator(deps),
    sendKeyx,
    applyLocalKey,
    loadRoster,
    aliceEcdhPubB64: await spkiB64(alice.publicKey),
    /** 模擬「既有 keyx 經 gossip 到達並被 consumeKeyx 安裝」（Spec 018 測試用） */
    installKey: (epoch: number) => {
      maxEpoch = Math.max(maxEpoch, epoch);
    },
  };
}

/** 名冊穩定後分發需要跨 tick 累積穩定度；連跑數輪讓閘門滿足 */
async function tickStable(coord: RoomKeyCoordinator, rounds = 3): Promise<void> {
  for (let i = 0; i < rounds; i++) await coord.tick();
}

const lastKeyx = (sendKeyx: ReturnType<typeof vi.fn>): KeyxRecordPayload =>
  JSON.parse(sendKeyx.mock.calls.at(-1)![0] as string) as KeyxRecordPayload;

describe('RoomKeyCoordinator（P2-②c 產生方編排）', () => {
  it('產生方分發 keyx：封給其他成員 + 安裝本機金鑰（epoch 0）', async () => {
    const { coord, sendKeyx, applyLocalKey, loadRoster, aliceEcdhPubB64 } = await setup();
    const bob = await ecdhPair();
    loadRoster.mockResolvedValue({
      members: [
        { userId: 'a-user', ecdhPubKey: aliceEcdhPubB64 },
        { userId: 'b-user', ecdhPubKey: await spkiB64(bob.publicKey) },
      ],
      participantCount: 2,
    });

    await tickStable(coord);

    expect(sendKeyx).toHaveBeenCalledTimes(1);
    expect(applyLocalKey).toHaveBeenCalledTimes(1);
    const payload = lastKeyx(sendKeyx);
    expect(payload.v).toBe('keyx1');
    expect(payload.keys).toHaveLength(2); // b-user + 自己（Spec 017：self 條目供 rejoin 回放復原）
    const members = payload.keys.map((k) => k.forMember).sort();
    expect(members).toEqual(['a-user', 'b-user']);
    expect(payload.keys.every((k) => k.epoch === 0)).toBe(true);
    expect(applyLocalKey.mock.calls[0]![1]).toBe(0);
  });

  it('全員 ecdh 未就緒（eligible < participants）：不分發，等全員註冊', async () => {
    const { coord, sendKeyx, loadRoster, aliceEcdhPubB64 } = await setup();
    const bob = await ecdhPair();
    loadRoster.mockResolvedValue({
      members: [
        { userId: 'a-user', ecdhPubKey: aliceEcdhPubB64 },
        { userId: 'b-user', ecdhPubKey: await spkiB64(bob.publicKey) },
      ],
      participantCount: 3, // 還有一人未註冊 mesh 身分
    });
    await tickStable(coord);
    expect(sendKeyx).not.toHaveBeenCalled();
  });

  it('名冊未穩定（每輪都在變）：不分發', async () => {
    const { coord, sendKeyx, loadRoster, aliceEcdhPubB64 } = await setup();
    const bob = await ecdhPair();
    const carol = await ecdhPair();
    // 每次 tick 回傳不同名冊 → stableCount 一直歸零
    loadRoster
      .mockResolvedValueOnce({
        members: [{ userId: 'a-user', ecdhPubKey: aliceEcdhPubB64 }],
        participantCount: 3,
      })
      .mockResolvedValueOnce({
        members: [
          { userId: 'a-user', ecdhPubKey: aliceEcdhPubB64 },
          { userId: 'b-user', ecdhPubKey: await spkiB64(bob.publicKey) },
        ],
        participantCount: 3,
      })
      .mockResolvedValue({
        members: [
          { userId: 'a-user', ecdhPubKey: aliceEcdhPubB64 },
          { userId: 'b-user', ecdhPubKey: await spkiB64(bob.publicKey) },
          { userId: 'c-user', ecdhPubKey: await spkiB64(carol.publicKey) },
        ],
        participantCount: 3,
      });
    // 前三輪名冊都在變 → 不分發
    await coord.tick();
    await coord.tick();
    await coord.tick();
    expect(sendKeyx).not.toHaveBeenCalled();
    // 名冊自此穩定，再跑一輪 → 分發
    await coord.tick();
    expect(sendKeyx).toHaveBeenCalledTimes(1);
    expect(lastKeyx(sendKeyx).keys).toHaveLength(3); // a(self, Spec 017) + b + c
  });

  it('冪等：穩定名冊多次 tick 只分發一次；名冊變動才重發（epoch 遞增）', async () => {
    const { coord, sendKeyx, loadRoster, aliceEcdhPubB64 } = await setup();
    const bob = await ecdhPair();
    const carol = await ecdhPair();
    const base = [
      { userId: 'a-user', ecdhPubKey: aliceEcdhPubB64 },
      { userId: 'b-user', ecdhPubKey: await spkiB64(bob.publicKey) },
    ];
    loadRoster.mockResolvedValue({ members: base, participantCount: 2 });

    await tickStable(coord, 4);
    expect(sendKeyx).toHaveBeenCalledTimes(1); // 穩定名冊只一次

    // 加入 carol → 名冊變動 → 穩定後重發，epoch = 已知最高(0)+1 = 1
    loadRoster.mockResolvedValue({
      members: [...base, { userId: 'c-user', ecdhPubKey: await spkiB64(carol.publicKey) }],
      participantCount: 3,
    });
    await tickStable(coord, 3);
    expect(sendKeyx).toHaveBeenCalledTimes(2);
    const payload = lastKeyx(sendKeyx);
    expect(payload.keys).toHaveLength(3); // a(self, Spec 017) + b + c
    expect(payload.keys.every((k) => k.epoch === 1)).toBe(true);
  });

  it('非產生方（非最小 userId）：不分發', async () => {
    const { coord, sendKeyx, loadRoster } = await setup({ localUserId: 'z-user' });
    loadRoster.mockResolvedValue({
      members: [
        { userId: 'a-user', ecdhPubKey: 'AAAA'.repeat(20) },
        { userId: 'z-user', ecdhPubKey: 'BBBB'.repeat(20) },
      ],
      participantCount: 2,
    });
    await tickStable(coord);
    expect(sendKeyx).not.toHaveBeenCalled();
  });

  it('名冊只有自己（<2 有效成員）：不分發（維持明文相容）', async () => {
    const { coord, sendKeyx, loadRoster } = await setup();
    loadRoster.mockResolvedValue({
      members: [{ userId: 'a-user', ecdhPubKey: 'AAAA'.repeat(20) }],
      participantCount: 1,
    });
    await tickStable(coord);
    expect(sendKeyx).not.toHaveBeenCalled();
  });

  it('自己的 ecdhPubKey 尚未在名冊（傳播中）：不分發，等下一輪', async () => {
    const { coord, sendKeyx, loadRoster } = await setup();
    loadRoster.mockResolvedValue({
      members: [{ userId: 'b-user', ecdhPubKey: 'BBBB'.repeat(20) }], // 只有 b，還沒看到自己
      participantCount: 2,
    });
    await tickStable(coord);
    expect(sendKeyx).not.toHaveBeenCalled();
  });

  it('rosterFromRoom：名冊＝meshIdentities ∩ participants（離開者被排除，前向保密前提）', () => {
    const meshIdentities = {
      uidA: { userId: 'a-user', ecdhPubKey: 'A'.repeat(60) },
      uidB: { userId: 'b-user', ecdhPubKey: 'B'.repeat(60) },
      uidC: { userId: 'c-user', ecdhPubKey: 'C'.repeat(60) }, // 已離開但 meshIdentity 殘留
    };
    // C 已 leaveRoom → 不在 participants
    const r = rosterFromRoom(meshIdentities, ['uidA', 'uidB']);
    expect(r.participantCount).toBe(2);
    expect(r.members.map((m) => m.userId).sort()).toEqual(['a-user', 'b-user']);
    // 關鍵：離開者 c-user 不在名冊 → 產生方不會續封鑰給它
    expect(r.members.some((m) => m.userId === 'c-user')).toBe(false);
  });

  it('rosterFromRoom：空/未定義輸入安全', () => {
    expect(rosterFromRoom(undefined, undefined)).toEqual({ members: [], participantCount: 0 });
    expect(rosterFromRoom({ u: { userId: 'x', ecdhPubKey: 'p' } }, [])).toEqual({
      members: [],
      participantCount: 0,
    });
  });

  it('密碼學鏈：成員用自己 ECDH 私鑰開出 keyx → 與本機安裝的同一把金鑰', async () => {
    const { alice, coord, sendKeyx, applyLocalKey, loadRoster, aliceEcdhPubB64 } = await setup();
    const bob = await ecdhPair();
    loadRoster.mockResolvedValue({
      members: [
        { userId: 'a-user', ecdhPubKey: aliceEcdhPubB64 },
        { userId: 'b-user', ecdhPubKey: await spkiB64(bob.publicKey) },
      ],
      participantCount: 2,
    });

    await tickStable(coord);

    // 本機（alice）安裝的金鑰
    const localKey = applyLocalKey.mock.calls[0]![0] as CryptoKey;
    // bob 從 keyx 開出的金鑰
    const payload = lastKeyx(sendKeyx);
    const mine = payload.keys.find((k) => k.forMember === 'b-user')!;
    const producerEcdh = await crypto.subtle.importKey(
      'spki',
      Uint8Array.from(atob(payload.producerEcdh), (c) => c.charCodeAt(0)),
      { name: 'ECDH', namedCurve: 'P-256' },
      true,
      []
    );
    const bobKey = await openSealedRoomKey(mine, bob.privateKey, producerEcdh);

    // 證明是同一把：alice 用本機金鑰加密、bob 用開出的金鑰解密
    const ct = await encryptRecordContent('房內密語', localKey, 0);
    expect(await decryptRecordContent(ct, bobKey)).toBe('房內密語');
    expect(alice).toBeTruthy();
  });
});

describe('Spec 018：第四道閘門（產生方交接寬限）', () => {
  async function rosterAB(aliceEcdhPubB64: string) {
    const bob = await ecdhPair();
    return {
      members: [
        { userId: 'a-user', ecdhPubKey: aliceEcdhPubB64 },
        { userId: 'b-user', ecdhPubKey: await spkiB64(bob.publicKey) },
      ],
      participantCount: 2,
    };
  }

  it('環空＋房間已運轉 → 延遲分發；觀察到既有 keyx（開不了也算）後以 observed+1 分發', async () => {
    let observed = -1;
    const { coord, sendKeyx, loadRoster, aliceEcdhPubB64 } = await setup({
      hasForeignRecords: () => true,
      getMaxObservedEpoch: () => observed,
    });
    loadRoster.mockResolvedValue(await rosterAB(aliceEcdhPubB64));

    await tickStable(coord, 4); // 穩定窗 + 寬限窗內
    expect(sendKeyx).not.toHaveBeenCalled(); // 修前此處已發 epoch 0（碰撞源）

    observed = 0; // 前任 keyx 經 anti-entropy 到達（新加入者開不了，但 epoch metadata 可讀）
    await coord.tick();
    expect(sendKeyx).toHaveBeenCalledTimes(1);
    expect(lastKeyx(sendKeyx).keys.every((k) => k.epoch === 1)).toBe(true); // 單調，無同代異鑰
  });

  it('bootstrap（無他人紀錄）：立即分發 epoch 0，行為與閘門加入前一致', async () => {
    const { coord, sendKeyx, loadRoster, aliceEcdhPubB64 } = await setup({
      hasForeignRecords: () => false,
    });
    loadRoster.mockResolvedValue(await rosterAB(aliceEcdhPubB64));

    await tickStable(coord, 2);
    expect(sendKeyx).toHaveBeenCalledTimes(1);
    expect(lastKeyx(sendKeyx).keys.every((k) => k.epoch === 0)).toBe(true);
  });

  it('liveness：寬限窗盡仍無 keyx → 照發 epoch 0（有界等待）', async () => {
    const { coord, sendKeyx, loadRoster, aliceEcdhPubB64 } = await setup({
      hasForeignRecords: () => true, // 永遠有他人紀錄但 keyx 永不到（理論明文房）
    });
    loadRoster.mockResolvedValue(await rosterAB(aliceEcdhPubB64));

    await tickStable(coord, 8); // 穩定窗 1 + 寬限 3 + 餘裕
    expect(sendKeyx).toHaveBeenCalledTimes(1);
    expect(lastKeyx(sendKeyx).keys.every((k) => k.epoch === 0)).toBe(true);
  });
});

/**
 * B5 驗證：殭屍 participant（join 成功但 meshIdentity 未註冊／舊 client 無 ecdhPubKey）
 * 會不會讓閘門 1 永不通過，使整房拿不到房間金鑰。
 */
describe('B5：殭屍 participant 對 keyx 分發的影響', () => {
  it('有一位 participant 未註冊 ecdh 身分 → keyx 永不分發（即使長時間穩定）', async () => {
    const { coord, sendKeyx, applyLocalKey, loadRoster, aliceEcdhPubB64 } = await setup();
    const bob = await ecdhPair();
    // participants 有 3 人，但只有 2 人在 meshIdentities 且帶 ecdhPubKey
    loadRoster.mockResolvedValue({
      members: [
        { userId: 'a-user', ecdhPubKey: aliceEcdhPubB64 },
        { userId: 'b-user', ecdhPubKey: await spkiB64(bob.publicKey) },
      ],
      participantCount: 3, // ← 第三人是殭屍
    });

    await tickStable(coord, 50); // 遠超穩定窗
    expect(sendKeyx).not.toHaveBeenCalled();
    expect(applyLocalKey).not.toHaveBeenCalled();
  });

  it('殭屍離開後（participantCount 回正）→ 分發恢復，證明鎖死來源是該閘門', async () => {
    const { coord, sendKeyx, loadRoster, aliceEcdhPubB64 } = await setup();
    const bob = await ecdhPair();
    const members = [
      { userId: 'a-user', ecdhPubKey: aliceEcdhPubB64 },
      { userId: 'b-user', ecdhPubKey: await spkiB64(bob.publicKey) },
    ];
    loadRoster.mockResolvedValue({ members, participantCount: 3 });
    await tickStable(coord, 20);
    expect(sendKeyx).not.toHaveBeenCalled();

    loadRoster.mockResolvedValue({ members, participantCount: 2 });
    await tickStable(coord, 5);
    expect(sendKeyx).toHaveBeenCalled();
  });

  it('名冊帶 ecdhPubKey 缺失的成員（舊 client）→ 同樣鎖住', async () => {
    const { coord, sendKeyx, loadRoster, aliceEcdhPubB64 } = await setup();
    loadRoster.mockResolvedValue({
      members: [
        { userId: 'a-user', ecdhPubKey: aliceEcdhPubB64 },
        { userId: 'old-client' }, // 無 ecdhPubKey → 不計入 eligible
      ],
      participantCount: 2,
    });
    await tickStable(coord, 30);
    expect(sendKeyx).not.toHaveBeenCalled();
  });
});

/** B5 第 1 項：分發受阻的原因可查詢（讓上層說得出「還在等什麼」） */
describe('B5：keyx 受阻狀態可觀測', () => {
  it('殭屍 participant → reason=awaiting-members，並回報還缺幾位', async () => {
    const { coord, loadRoster, aliceEcdhPubB64 } = await setup();
    const bob = await ecdhPair();
    loadRoster.mockResolvedValue({
      members: [
        { userId: 'a-user', ecdhPubKey: aliceEcdhPubB64 },
        { userId: 'b-user', ecdhPubKey: await spkiB64(bob.publicKey) },
      ],
      participantCount: 4, // 兩位尚未註冊
    });
    await tickStable(coord, 3);

    const s = coord.getKeyxStatus();
    expect(s.reason).toBe('awaiting-members');
    expect(s.pendingMembers).toBe(2);
  });

  it('blockedForMs 隨時間累加（同一原因不重設起算點）', async () => {
    const { coord, loadRoster, aliceEcdhPubB64 } = await setup();
    const bob = await ecdhPair();
    loadRoster.mockResolvedValue({
      members: [
        { userId: 'a-user', ecdhPubKey: aliceEcdhPubB64 },
        { userId: 'b-user', ecdhPubKey: await spkiB64(bob.publicKey) },
      ],
      participantCount: 3,
    });
    // blockSince 取 Date.now()，故查詢時基必須與之一致
    const base = Date.now();
    await coord.tick();
    const t0 = coord.getKeyxStatus(base);
    await coord.tick(); // 第二輪仍是同一原因 → 起算點不該被重設
    const t1 = coord.getKeyxStatus(base + 30_000);
    expect(t0.reason).toBe('awaiting-members');
    expect(t1.reason).toBe('awaiting-members');
    expect(t1.blockedForMs).toBeGreaterThanOrEqual(t0.blockedForMs + 29_000);
  });

  it('分發成功後 reason 回到 none', async () => {
    const { coord, sendKeyx, loadRoster, aliceEcdhPubB64 } = await setup();
    const bob = await ecdhPair();
    loadRoster.mockResolvedValue({
      members: [
        { userId: 'a-user', ecdhPubKey: aliceEcdhPubB64 },
        { userId: 'b-user', ecdhPubKey: await spkiB64(bob.publicKey) },
      ],
      participantCount: 2,
    });
    await tickStable(coord);
    expect(sendKeyx).toHaveBeenCalled();
    expect(coord.getKeyxStatus().reason).toBe('none');
  });

  it('非產生方不算「被擋」（正常分工，不該對使用者說明）', async () => {
    // 本機 userId 排序不是最小 → 非產生方
    const { coord, loadRoster } = await setup({ localUserId: 'z-user' });
    const other = await ecdhPair();
    const me = await ecdhPair();
    loadRoster.mockResolvedValue({
      members: [
        { userId: 'a-user', ecdhPubKey: await spkiB64(other.publicKey) },
        { userId: 'z-user', ecdhPubKey: await spkiB64(me.publicKey) },
      ],
      participantCount: 2,
    });
    await tickStable(coord);
    expect(coord.getKeyxStatus().reason).toBe('none');
  });
});
