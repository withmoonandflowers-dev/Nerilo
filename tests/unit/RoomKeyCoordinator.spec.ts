/**
 * ADR-0023 P2-②c：RoomKeyCoordinator — 產生方側編排
 * - 產生方（完整穩定名冊中 userId 字典序最小者）分發 keyx；封給所有其他成員、安裝本機金鑰
 * - 三道閘門：全員 ecdh 就緒（eligible==participants）＋名冊連續穩定＋完整名冊最小者
 * - 冪等：穩定名冊只分發一次；名冊變動才重發（epoch = 已知最高+1）
 * - 非產生方 / 名冊<2 / 自己未在名冊 / participant 未全就緒 → no-op（無鑰退明文相容）
 * - 密碼學鏈：分發的 keyx 內，成員以自己的 ECDH 私鑰開得出「與本機安裝的同一把」金鑰
 */
import { describe, it, expect, vi } from 'vitest';
import { RoomKeyCoordinator } from '../../src/core/mesh/RoomKeyCoordinator';
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
async function setup(opts?: { localUserId?: string }) {
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
  };
  return {
    alice,
    coord: new RoomKeyCoordinator(deps),
    sendKeyx,
    applyLocalKey,
    loadRoster,
    aliceEcdhPubB64: await spkiB64(alice.publicKey),
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
    expect(payload.keys).toHaveLength(1); // 只封給 b-user（不封自己）
    expect(payload.keys[0]!.forMember).toBe('b-user');
    expect(payload.keys[0]!.epoch).toBe(0);
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
    expect(lastKeyx(sendKeyx).keys).toHaveLength(2); // b + c
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
    expect(payload.keys).toHaveLength(2); // b + c
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
