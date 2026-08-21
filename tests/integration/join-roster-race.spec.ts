/**
 * 名冊競態下的 p2pRooms 更新授權。
 *
 * 背景：rules 拿「已提交的文件」評估，且評在 updateTime 前置條件之前。兩人同時
 * 入房時，後手送出的名冊是照舊快照算的，少了先手那個人。isSelfJoinOnly() 的
 * 「不得移除既有成員」必須擋下這種寫入，否則後手會靜默把先手踢出房間
 *（2026-08-06 之前的舊規則就是這樣放行的）。
 *
 * 被擋下時客戶端拿到的是 permission-denied 而非 aborted，Firebase SDK 不會自己
 * 重試，所以 RoomService.joinRoom 把它列為可重試（見 RoomServiceJoinRetry.spec.ts）。
 * CI 的 mesh-e2ee 三人同時入房 2026-08-07 至 08-09 連三天紅在這個組合上。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { doc, updateDoc, Timestamp } from 'firebase/firestore';
import { clearEmulatorData, createTestUser, adminDb } from './helpers/admin-client';
import { signInWithToken, cleanupWebClients } from './helpers/web-client';

const OWNER = 'race-owner', FIRST = 'race-first', SECOND = 'race-second';
const DAY = 86_400_000;

async function seedRoom(id: string, participants: string[], status: string) {
  await adminDb().collection('p2pRooms').doc(id).set({
    ownerUid: OWNER,
    participants,
    participantCount: participants.length,
    status,
    lastActiveAt: Date.now(),
    ttlExpireAt: new Date(Date.now() + DAY),
  });
}

async function writeRoster(client: string, uid: string, roomId: string, roster: string[]) {
  const token = await createTestUser(uid);
  const { db } = await signInWithToken(client, token);
  try {
    await updateDoc(doc(db, 'p2pRooms', roomId), {
      participants: roster,
      participantCount: roster.length,
      status: 'open',
      lastActiveAt: Date.now(),
      ttlExpireAt: Timestamp.fromMillis(Date.now() + DAY),
    });
    return 'allowed';
  } catch (e) {
    return (e as { code?: string })?.code ?? String(e);
  }
}

describe('Firestore Rules: 併發入房的名冊競態', () => {
  beforeAll(async () => {
    await clearEmulatorData();
    await createTestUser(OWNER);
  });
  afterAll(async () => {
    await cleanupWebClients();
  });

  it('名冊未被別人動過時，自行加入並啟用 waiting 房會放行', async () => {
    await seedRoom('race-clean', [OWNER], 'waiting');
    expect(await writeRoster('c-clean', SECOND, 'race-clean', [OWNER, SECOND])).toBe('allowed');
  });

  it('帶著過期名冊寫入會被擋下，不得把先入房者洗掉', async () => {
    await seedRoom('race-stale', [OWNER, FIRST], 'open');
    expect(await writeRoster('c-stale', SECOND, 'race-stale', [OWNER, SECOND]))
      .toBe('permission-denied');

    // 先入房者必須還在
    const after = await adminDb().collection('p2pRooms').doc('race-stale').get();
    expect(after.data()?.['participants']).toContain(FIRST);
  });

  it('重讀取得正確名冊後再寫入即放行（joinRoom 重試後走的就是這條）', async () => {
    await seedRoom('race-retry', [OWNER, FIRST], 'open');
    expect(await writeRoster('c-retry', SECOND, 'race-retry', [OWNER, FIRST, SECOND]))
      .toBe('allowed');
  });
});

/**
 * B6：併發身分註冊。修復前 updateMeshIdentity 是「讀整張 meshIdentities → 本地插入
 * 自己 → 整份覆寫」；同時進場者拿著各自的舊快照互相覆寫，後到者會刪掉快照中沒有的
 * 他人條目 → meshIdentitiesChangeIsValid 判 permission-denied → 重試耗盡即整條初始化失敗。
 * 改用 dotted field path 後，兩人以「彼此都看不到對方」的舊快照寫入也必須同時成功。
 */
describe('Firestore Rules: 併發 meshIdentity 註冊（B6）', () => {
  const ROOM = 'room-b6-concurrent';
  const PUB = 'A'.repeat(64);

  beforeAll(async () => {
    if (!process.env['FIRESTORE_EMULATOR_HOST']) return;
    await clearEmulatorData();
  }, 30_000);

  it('兩人各自以「看不到對方」的舊快照寫入身分 → 皆放行且互不覆蓋', async () => {
    if (!process.env['FIRESTORE_EMULATOR_HOST']) return;
    // 兩人都已在 participants（join 已傳播），名冊為空——兩人此刻的快照都是 {}
    await seedRoom(ROOM, [FIRST, SECOND], 'open');

    async function registerSelf(client: string, uid: string) {
      const token = await createTestUser(uid);
      const { db } = await signInWithToken(client, token);
      try {
        // dotted path：只寫自己那一格（B6 修法）
        await updateDoc(doc(db, 'p2pRooms', ROOM), {
          [`meshIdentities.${uid}`]: { userId: `user-${uid}`, pubKey: PUB, joinedAt: Date.now() },
          topology: 'mesh',
        });
        return 'allowed';
      } catch (e) {
        return (e as { code?: string })?.code ?? String(e);
      }
    }

    expect(await registerSelf('b6-first', FIRST)).toBe('allowed');
    // 第二人此刻若走「整份覆寫」會刪掉 FIRST 的條目而被擋；dotted path 應照樣放行
    expect(await registerSelf('b6-second', SECOND)).toBe('allowed');

    // 兩人的條目都在（互不覆蓋）
    const snap = await adminDb().collection('p2pRooms').doc(ROOM).get();
    const mi = (snap.data()?.meshIdentities ?? {}) as Record<string, unknown>;
    expect(Object.keys(mi).sort()).toEqual([FIRST, SECOND].sort());
  });

  it('對照：整份覆寫（舊寫法）在對方已註冊後會被 rules 擋下', async () => {
    if (!process.env['FIRESTORE_EMULATOR_HOST']) return;
    await seedRoom(ROOM, [FIRST, SECOND], 'open');
    // FIRST 先註冊
    const t1 = await createTestUser(FIRST);
    const { db: db1 } = await signInWithToken('b6-old-first', t1);
    await updateDoc(doc(db1, 'p2pRooms', ROOM), {
      [`meshIdentities.${FIRST}`]: { userId: `user-${FIRST}`, pubKey: PUB, joinedAt: Date.now() },
      topology: 'mesh',
    });

    // SECOND 帶著「還沒看到 FIRST」的舊快照做整份覆寫 → 等於刪掉 FIRST 的條目
    const t2 = await createTestUser(SECOND);
    const { db: db2 } = await signInWithToken('b6-old-second', t2);
    let outcome: string;
    try {
      await updateDoc(doc(db2, 'p2pRooms', ROOM), {
        meshIdentities: { [SECOND]: { userId: `user-${SECOND}`, pubKey: PUB, joinedAt: Date.now() } },
        topology: 'mesh',
      });
      outcome = 'allowed';
    } catch (e) {
      outcome = (e as { code?: string })?.code ?? String(e);
    }
    expect(outcome).toBe('permission-denied'); // 這正是修復前的失敗來源
  });
});
