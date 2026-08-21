/**
 * M-1 / M-2 / M-4 規則回歸（需 Firebase Emulator）
 *
 * M-1：friendships update 未限制 affectedKeys → 接受方可在同一次寫入改寫
 *      uids/requestedBy/names，把自己塞進他人好友清單（釣魚介面）。
 * M-2：friendships create 未綁定文件 id → 可用隨機 id 對同一受害者洪水式邀請。
 * M-4：p2pRooms/{id}/messages create 無大小上限 → 可用逼近 1MiB 的文件燒配額。
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { doc, setDoc, addDoc, updateDoc, deleteDoc, collection, Timestamp } from 'firebase/firestore';
import { clearEmulatorData, createTestUser, adminDb } from './helpers/admin-client';
import { signInWithToken, cleanupWebClients } from './helpers/web-client';

const UID_A = 'uid-aaa-friend';
const UID_B = 'uid-bbb-friend';
const UID_VICTIM = 'uid-zzz-victim';

// 同步檢查環境變數：setupFiles (emulator-env.ts) 在測試收集前已執行。
// 必須同步初始化——describe 的 withEmulator 在收集階段就會讀它，早於 beforeAll。
let emulatorAvailable = !!process.env['FIRESTORE_EMULATOR_HOST'];

async function isEmulatorRunning(): Promise<boolean> {
  const host = process.env['FIRESTORE_EMULATOR_HOST'];
  if (!host) return false;
  const [hostname, portStr] = host.split(':');
  const http = await import('node:http');
  return new Promise<boolean>((resolve) => {
    const req = http.get({ hostname, port: Number(portStr), path: '/', timeout: 3000 }, () => resolve(true));
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
  });
}

async function assertDenied(operation: () => Promise<unknown>): Promise<void> {
  try {
    await operation();
    throw new Error('Expected PERMISSION_DENIED but operation succeeded');
  } catch (err: unknown) {
    const msg = String((err as { code?: string; message?: string }).code ?? (err as { message?: string }).message ?? err);
    const isDenied =
      msg.includes('permission-denied') ||
      msg.includes('PERMISSION_DENIED') ||
      msg.includes('Missing or insufficient permissions');
    expect(isDenied, `Expected PERMISSION_DENIED, got: ${msg}`).toBe(true);
  }
}

function withEmulator(fn: () => void) {
  return () => {
    if (!emulatorAvailable) {
      it.skip('Emulator 未啟動，跳過整合測試');
      return;
    }
    fn();
  };
}

const pairId = (a: string, b: string) => [a, b].sort().join('_');

/** 以 Admin SDK 種一筆 pending 邀請（繞過規則）。Admin SDK 需用 JS Date 而非 Web SDK Timestamp。 */
async function seedPending(id: string): Promise<void> {
  await adminDb().collection('friendships').doc(id).set({
    uids: [UID_A, UID_B].sort(),
    names: { [UID_A]: 'A' },
    requestedBy: UID_A,
    status: 'pending',
    createdAt: new Date(),
  });
}

beforeAll(async () => {
  if (emulatorAvailable) {
    emulatorAvailable = await isEmulatorRunning(); // 再探測確認，失敗則降級
  }
  if (emulatorAvailable) await clearEmulatorData();
}, 30_000);

afterAll(async () => {
  if (emulatorAvailable) {
    await clearEmulatorData().catch(() => {});
    await cleanupWebClients();
  }
});

describe('Firestore Rules: friendships（M-1 / M-2）', withEmulator(() => {
  beforeEach(async () => {
    await clearEmulatorData();
  });

  it('正當流程：以排序 id 建立 pending 邀請可放行', async () => {
    const token = await createTestUser(UID_A);
    const { db } = await signInWithToken('fr-ok', token);
    const id = pairId(UID_A, UID_B);
    await setDoc(doc(db, 'friendships', id), {
      uids: [UID_A, UID_B].sort(),
      names: { [UID_A]: 'A' },
      requestedBy: UID_A,
      status: 'pending',
      createdAt: Timestamp.now(),
    });
  });

  it('M-2：文件 id 與 uids 不符（隨機 id 洪水）被擋下', async () => {
    const token = await createTestUser(UID_A);
    const { db } = await signInWithToken('fr-flood', token);
    await assertDenied(() =>
      setDoc(doc(db, 'friendships', 'random-flood-id-1'), {
        uids: [UID_A, UID_VICTIM].sort(),
        names: { [UID_A]: 'A' },
        requestedBy: UID_A,
        status: 'pending',
        createdAt: Timestamp.now(),
      })
    );
  });

  it('M-2：uids 未排序（等價於可繞過 id 綁定）被擋下', async () => {
    const token = await createTestUser(UID_B);
    const { db } = await signInWithToken('fr-unsorted', token);
    const [lo, hi] = [UID_A, UID_B].sort();
    await assertDenied(() =>
      setDoc(doc(db, 'friendships', `${hi}_${lo}`), {
        uids: [hi, lo],
        names: { [UID_B]: 'B' },
        requestedBy: UID_B,
        status: 'pending',
        createdAt: Timestamp.now(),
      })
    );
  });

  it('M-2：不能把自己加為好友（uids[0] < uids[1] 保證相異）', async () => {
    const token = await createTestUser(UID_A);
    const { db } = await signInWithToken('fr-self', token);
    await assertDenied(() =>
      setDoc(doc(db, 'friendships', `${UID_A}_${UID_A}`), {
        uids: [UID_A, UID_A],
        names: { [UID_A]: 'A' },
        requestedBy: UID_A,
        status: 'pending',
        createdAt: Timestamp.now(),
      })
    );
  });

  it('M-1：接受方正當 accept（只動白名單欄位）放行', async () => {
    const id = pairId(UID_A, UID_B);
    await seedPending(id);
    const token = await createTestUser(UID_B);
    const { db } = await signInWithToken('fr-accept', token);
    await updateDoc(doc(db, 'friendships', id), {
      status: 'accepted',
      acceptedAt: Timestamp.now(),
      dmRoomId: 'room-dm-1',
      [`names.${UID_B}`]: 'B',
    });
  });

  it('M-1：accept 同時改寫 uids（把受害者塞進來）被擋下', async () => {
    const id = pairId(UID_A, UID_B);
    await seedPending(id);
    const token = await createTestUser(UID_B);
    const { db } = await signInWithToken('fr-hijack', token);
    await assertDenied(() =>
      updateDoc(doc(db, 'friendships', id), {
        status: 'accepted',
        acceptedAt: Timestamp.now(),
        uids: [UID_B, UID_VICTIM].sort(), // 洗掉原對象，塞入受害者
      })
    );
  });

  it('M-1：accept 同時改寫他人 names（冒充官方客服）被擋下', async () => {
    const id = pairId(UID_A, UID_B);
    await seedPending(id);
    const token = await createTestUser(UID_B);
    const { db } = await signInWithToken('fr-name', token);
    await assertDenied(() =>
      updateDoc(doc(db, 'friendships', id), {
        status: 'accepted',
        [`names.${UID_A}`]: '官方客服', // 改別人那一格
      })
    );
  });

  it('M-1：accept 同時改寫 requestedBy 被擋下', async () => {
    const id = pairId(UID_A, UID_B);
    await seedPending(id);
    const token = await createTestUser(UID_B);
    const { db } = await signInWithToken('fr-reqby', token);
    await assertDenied(() =>
      updateDoc(doc(db, 'friendships', id), {
        status: 'accepted',
        requestedBy: UID_B,
      })
    );
  });
}));

describe('Firestore Rules: messages 大小上限（M-4）', withEmulator(() => {
  const ROOM = 'room-msg-size';

  beforeEach(async () => {
    await clearEmulatorData();
    await adminDb().collection('p2pRooms').doc(ROOM).set({
      ownerUid: UID_A,
      participants: [UID_A],
      status: 'open',
      isPrivate: false,
      createdAt: new Date(), // Admin SDK：用 JS Date，不可用 Web SDK 的 Timestamp
    });
  });

  function msg(content: string) {
    const now = Timestamp.now();
    return {
      messageId: 'm-1',
      from: UID_A,
      content,
      createdAt: now,
      expiresAt: Timestamp.fromMillis(now.toMillis() + 60_000),
      timestamp: now,
      edited: false,
      deleted: false,
    };
  }

  it('正常大小訊息放行', async () => {
    const token = await createTestUser(UID_A);
    const { db } = await signInWithToken('msg-ok', token);
    await addDoc(collection(db, 'p2pRooms', ROOM, 'messages'), msg('hello'));
  });

  it('M-4：逼近 1MiB 的巨大訊息被擋下（配額耗盡防護）', async () => {
    const token = await createTestUser(UID_A);
    const { db } = await signInWithToken('msg-huge', token);
    const huge = 'x'.repeat(200 * 1024); // 200KB > 64KB 上限
    await assertDenied(() =>
      addDoc(collection(db, 'p2pRooms', ROOM, 'messages'), msg(huge))
    );
  });
}));

// ─────────────────────────────────────────────────────────────────────────
// H-3：relaySignals 通道 id 綁定
// ─────────────────────────────────────────────────────────────────────────

describe('Firestore Rules: relaySignals 通道綁定（H-3）', withEmulator(() => {
  beforeEach(async () => {
    await clearEmulatorData();
  });

  function chan(participants: string[]) {
    return {
      participants,
      expiresAt: Timestamp.fromMillis(Date.now() + 10 * 60_000),
    };
  }

  it('正當通道（id = 排序後 uid 以 __ 串接）放行', async () => {
    const token = await createTestUser(UID_A);
    const { db } = await signInWithToken('rs-ok', token);
    const [lo, hi] = [UID_A, UID_B].sort();
    await setDoc(doc(db, 'relaySignals', `${lo}__${hi}`), chan([lo, hi]));
  });

  it('H-3：任意 id 開通道被擋下（此前可對同一受害者開無限條，每條強迫一次 WebRTC 協商）', async () => {
    const token = await createTestUser(UID_A);
    const { db } = await signInWithToken('rs-flood', token);
    const [lo, hi] = [UID_A, UID_VICTIM].sort();
    await assertDenied(() =>
      setDoc(doc(db, 'relaySignals', `probe-${Date.now()}`), chan([lo, hi]))
    );
  });

  it('H-3：participants 未排序（繞過 id 綁定）被擋下', async () => {
    const token = await createTestUser(UID_A);
    const { db } = await signInWithToken('rs-unsorted', token);
    const [lo, hi] = [UID_A, UID_VICTIM].sort();
    await assertDenied(() =>
      setDoc(doc(db, 'relaySignals', `${hi}__${lo}`), chan([hi, lo]))
    );
  });
}));

// ─────────────────────────────────────────────────────────────────────────
// M-5：房間刪除需房主或「全員軟刪除」
// ─────────────────────────────────────────────────────────────────────────

describe('Firestore Rules: 房間刪除（M-5）', withEmulator(() => {
  const ROOM = 'room-del';

  async function seedRoom(participants: string[]) {
    await adminDb().collection('p2pRooms').doc(ROOM).set({
      ownerUid: UID_A,
      participants,
      status: 'open',
      isPrivate: false,
      createdAt: new Date(),
    });
  }
  async function seedSoftDelete(uid: string) {
    await adminDb()
      .collection('p2pRooms').doc(ROOM)
      .collection('memberStates').doc(uid)
      .set({ deletedAt: Date.now() });
  }

  beforeEach(async () => {
    await clearEmulatorData();
  });

  it('房主可刪除', async () => {
    await seedRoom([UID_A, UID_B]);
    const token = await createTestUser(UID_A);
    const { db } = await signInWithToken('del-owner', token);
    await deleteDoc(doc(db, 'p2pRooms', ROOM));
  });

  it('M-5：非房主參與者不得直接刪整房（此前任何人加入公開房即可刪）', async () => {
    await seedRoom([UID_A, UID_B]);
    const token = await createTestUser(UID_B);
    const { db } = await signInWithToken('del-grief', token);
    await assertDenied(() => deleteDoc(doc(db, 'p2pRooms', ROOM)));
  });

  it('M-5：只有自己軟刪除、對方未刪 → 仍不得真刪', async () => {
    await seedRoom([UID_A, UID_B]);
    await seedSoftDelete(UID_B);
    const token = await createTestUser(UID_B);
    const { db } = await signInWithToken('del-partial', token);
    await assertDenied(() => deleteDoc(doc(db, 'p2pRooms', ROOM)));
  });

  it('M-5：雙方都已軟刪除 → 最後一人可真刪（既有正當路徑保留）', async () => {
    await seedRoom([UID_A, UID_B]);
    await seedSoftDelete(UID_A);
    await seedSoftDelete(UID_B);
    const token = await createTestUser(UID_B);
    const { db } = await signInWithToken('del-both', token);
    await deleteDoc(doc(db, 'p2pRooms', ROOM));
  });
}));
