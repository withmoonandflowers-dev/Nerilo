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
