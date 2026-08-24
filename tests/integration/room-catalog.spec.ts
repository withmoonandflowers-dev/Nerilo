/**
 * createFirestoreRoomCatalog 整合測試（Spec 014 T4/V2/V4，emulator 下執行）。
 *
 * 驗證與 InMemory 版同語義的契約行為在**真實 rules** 下成立：
 * 註冊帳號 publish → list 看得到（status open、isPrivate false）；unpublish → 消失且冪等。
 * V4：私人房與已關閉房不出現在任何人的 list（伺服器端過濾，不是 client 禮貌）。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { signInWithCustomToken } from 'firebase/auth';
import { clearEmulatorData, createTestUser, adminDb } from './helpers/admin-client';
import { cleanupWebClients } from './helpers/web-client';

const HOST = 'catalog-host';
const RUN = Boolean(process.env['FIRESTORE_EMULATOR_HOST']);

describe('SDK createFirestoreRoomCatalog（真實 rules）', () => {
  let hostToken = '';

  beforeAll(async () => {
    if (!RUN) return;
    hostToken = await createTestUser(HOST);
    const { auth } = await import('../../src/config/firebase');
    await signInWithCustomToken(auth, hostToken);
  });

  afterAll(async () => {
    if (!RUN) return;
    await cleanupWebClients();
    await clearEmulatorData();
  });

  it.runIf(RUN)('publish → list 看得到（open、公開、含名稱/容量映射）；unpublish → 消失且冪等', async () => {
    const { createFirestoreRoomCatalog } = await import('../../src/sdk/firestore');
    const cat = createFirestoreRoomCatalog({ uid: HOST, ownerName: '房主' });

    const id = await cat.publish({ name: '大廳測試房', capacity: 5, meta: { mode: 'pvp' } });
    expect(id).toBeTruthy();

    const rooms = await cat.list();
    const mine = rooms.find((r) => r.id === id);
    expect(mine).toBeDefined();
    expect(mine!.name).toBe('大廳測試房');
    expect(mine!.occupancy).toBe(1);
    expect(mine!.capacity).toBe(5);

    await cat.unpublish(id);
    const after = await cat.list();
    expect(after.find((r) => r.id === id)).toBeUndefined();
    await expect(cat.unpublish(id)).resolves.toBeUndefined(); // closed 房再關：既有語義允許（仍在）或冪等吞掉
  });

  it.runIf(RUN)('V4 授權不是口頭的：私人房與 closed 房不進任何人的 list', async () => {
    const { createFirestoreRoomCatalog } = await import('../../src/sdk/firestore');
    const cat = createFirestoreRoomCatalog({ uid: HOST });

    // admin 直接 seed 一間私人房與一間 closed 房（繞過 client 路徑，驗伺服器端過濾）
    const far = Date.now() + 86_400_000;
    const { Timestamp } = await import('firebase-admin/firestore');
    await adminDb().collection('p2pRooms').doc('cat-private').set({
      roomId: 'cat-private', ownerUid: HOST, participants: [HOST], status: 'open',
      isPrivate: true, createdAt: Date.now(), ttlExpireAt: Timestamp.fromMillis(far),
    });
    await adminDb().collection('p2pRooms').doc('cat-closed').set({
      roomId: 'cat-closed', ownerUid: HOST, participants: [HOST], status: 'closed',
      isPrivate: false, createdAt: Date.now(), ttlExpireAt: Timestamp.fromMillis(far),
    });

    const ids = (await cat.list()).map((r) => r.id);
    expect(ids).not.toContain('cat-private');
    expect(ids).not.toContain('cat-closed');
  });
});
