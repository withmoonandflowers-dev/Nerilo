/**
 * Firestore 安全規則 整合測試
 *
 * 這些測試必須搭配 Firebase Local Emulator 執行：
 *   firebase emulators:start --only auth,firestore
 *   npm run test:integration
 *
 * 測試架構（業界標準）：
 *  - Admin SDK  → 繞過規則，用於 seed 資料與清理
 *  - Web SDK    → 受規則約束，模擬真實使用者行為
 *  - 預期 PERMISSION_DENIED 的操作包裝成 assertDenied()
 *
 * 覆蓋範圍（對應 firestore.rules）：
 *  ✓ /features/{id}
 *  ✓ /users/{uid}
 *  ✓ /p2pRooms/{roomId}
 *  ✓ /p2pRooms/{roomId}/signals/{id}
 *  ✓ /p2pRooms/{roomId}/messages/{id}
 *  ✓ catch-all deny rule
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import {
  doc, getDoc, setDoc, addDoc, updateDoc, deleteDoc,
  collection, serverTimestamp,
} from 'firebase/firestore';
import {
  clearEmulatorData,
  createTestUser,
  adminDb,
  TEST_PROJECT_ID,
} from './helpers/admin-client';
import {
  signInWithToken,
  signInAnon,
  unauthDb,
  cleanupWebClients,
} from './helpers/web-client';

// ── Emulator 可用性檢查 ───────────────────────────────────────────────────

async function isEmulatorRunning(): Promise<boolean> {
  try {
    const res = await fetch(
      `http://127.0.0.1:4000/`,
      { signal: AbortSignal.timeout(2000) }
    );
    return res.ok || res.status === 404; // 只要 HTTP 可達即可
  } catch {
    try {
      // UI 可能未啟用，直接試 Firestore emulator 的 healthz
      const res2 = await fetch(
        `http://127.0.0.1:8080/`,
        { signal: AbortSignal.timeout(2000) }
      );
      return res2.ok || res2.status === 404;
    } catch {
      return false;
    }
  }
}

// ── Helper：斷言操作被拒絕 ─────────────────────────────────────────────────

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

// ── 測試用常數 ────────────────────────────────────────────────────────────

const UID_OWNER = 'test-owner-uid';
const UID_MEMBER = 'test-member-uid';
const UID_STRANGER = 'test-stranger-uid';
const UID_ADMIN = 'test-admin-uid';
const ROOM_ID = 'test-room-001';

// ── 全域 setup / teardown ────────────────────────────────────────────────

let emulatorAvailable = false;

beforeAll(async () => {
  emulatorAvailable = await isEmulatorRunning();
  if (!emulatorAvailable) {
    console.warn(
      '\n⚠  Firebase Emulator 未偵測到（127.0.0.1:8080）。\n' +
      '   整合測試將全部 skip。\n' +
      '   啟動方式：firebase emulators:start --only auth,firestore\n'
    );
    return;
  }

  await clearEmulatorData();
}, 30_000);

afterAll(async () => {
  if (emulatorAvailable) {
    await clearEmulatorData().catch(() => {});
    await cleanupWebClients();
  }
});

// ── 每個 describe 前清空資料，確保測試隔離 ──────────────────────────────

function withEmulator(fn: () => void) {
  return () => {
    if (!emulatorAvailable) {
      it.skip('Emulator 未啟動，跳過整合測試');
      return;
    }
    fn();
  };
}

// ─────────────────────────────────────────────────────────────────────────
// 1. /features/{featureId}
// ─────────────────────────────────────────────────────────────────────────

describe(
  'Firestore Rules: /features',
  withEmulator(() => {
    const FEAT_ID = 'chat';

    beforeEach(async () => {
      await clearEmulatorData();
      // 用 admin 建立測試資料（繞過規則）
      await adminDb()
        .collection('features')
        .doc(FEAT_ID)
        .set({ name: 'Chat', enabled: true });
    });

    it('已登入使用者可讀取 feature', async () => {
      const token = await createTestUser(UID_OWNER);
      const { db } = await signInWithToken('owner', token);
      const snap = await getDoc(doc(db, 'features', FEAT_ID));
      expect(snap.exists()).toBe(true);
    });

    it('未登入使用者無法讀取 feature', async () => {
      await assertDenied(() =>
        getDoc(doc(unauthDb(), 'features', FEAT_ID))
      );
    });

    it('非 admin 無法寫入 feature', async () => {
      const token = await createTestUser(UID_OWNER); // 無 admin claim
      const { db } = await signInWithToken('owner-write', token);
      await assertDenied(() =>
        setDoc(doc(db, 'features', 'new-feat'), { name: 'New' })
      );
    });

    it('admin 可寫入 feature', async () => {
      const token = await createTestUser(UID_ADMIN, { role: 'admin' });
      const { db } = await signInWithToken('admin', token);
      await setDoc(doc(db, 'features', 'new-feat'), { name: 'New', enabled: false });
      const snap = await adminDb().collection('features').doc('new-feat').get();
      expect(snap.exists).toBe(true);
    });
  })
);

// ─────────────────────────────────────────────────────────────────────────
// 2. /users/{uid}
// ─────────────────────────────────────────────────────────────────────────

describe(
  'Firestore Rules: /users',
  withEmulator(() => {
    beforeEach(async () => {
      await clearEmulatorData();
      await adminDb().collection('users').doc(UID_OWNER).set({ displayName: 'Owner' });
    });

    it('使用者可讀取自己的 profile', async () => {
      const token = await createTestUser(UID_OWNER);
      const { db, uid } = await signInWithToken('owner', token);
      const snap = await getDoc(doc(db, 'users', uid));
      expect(snap.exists()).toBe(true);
    });

    it('使用者無法讀取他人的 profile', async () => {
      const token = await createTestUser(UID_STRANGER);
      const { db } = await signInWithToken('stranger', token);
      await assertDenied(() =>
        getDoc(doc(db, 'users', UID_OWNER))
      );
    });

    it('使用者可更新自己的 profile', async () => {
      const token = await createTestUser(UID_OWNER);
      const { db, uid } = await signInWithToken('owner', token);
      await updateDoc(doc(db, 'users', uid), { displayName: 'Updated' });
    });

    it('使用者無法刪除自己的 profile（前端禁止）', async () => {
      const token = await createTestUser(UID_OWNER);
      const { db, uid } = await signInWithToken('owner', token);
      await assertDenied(() => deleteDoc(doc(db, 'users', uid)));
    });
  })
);

// ─────────────────────────────────────────────────────────────────────────
// 3. /p2pRooms/{roomId}
// ─────────────────────────────────────────────────────────────────────────

describe(
  'Firestore Rules: /p2pRooms — 讀取',
  withEmulator(() => {
    beforeEach(async () => {
      await clearEmulatorData();
      // 公開房間
      await adminDb().collection('p2pRooms').doc(ROOM_ID).set({
        ownerUid: UID_OWNER,
        participants: [UID_OWNER, UID_MEMBER],
        isPrivate: false,
        status: 'open',
        createdAt: Date.now(),
      });
      // 私密房間
      await adminDb().collection('p2pRooms').doc('private-room').set({
        ownerUid: UID_OWNER,
        participants: [UID_OWNER],
        isPrivate: true,
        status: 'waiting',
        createdAt: Date.now(),
      });
    });

    it('已登入使用者可讀取公開房間', async () => {
      const token = await createTestUser(UID_STRANGER);
      const { db } = await signInWithToken('stranger', token);
      const snap = await getDoc(doc(db, 'p2pRooms', ROOM_ID));
      expect(snap.exists()).toBe(true);
    });

    it('非參與者無法讀取私密房間', async () => {
      const token = await createTestUser(UID_STRANGER);
      const { db } = await signInWithToken('stranger', token);
      await assertDenied(() =>
        getDoc(doc(db, 'p2pRooms', 'private-room'))
      );
    });

    it('私密房間的參與者可讀取', async () => {
      const token = await createTestUser(UID_OWNER);
      const { db } = await signInWithToken('owner', token);
      const snap = await getDoc(doc(db, 'p2pRooms', 'private-room'));
      expect(snap.exists()).toBe(true);
    });
  })
);

describe(
  'Firestore Rules: /p2pRooms — 建立',
  withEmulator(() => {
    beforeEach(clearEmulatorData);

    it('⚠ 匿名使用者不可建立房間（關鍵規則）', async () => {
      const { db, uid } = await signInAnon('anon-creator');
      await assertDenied(() =>
        setDoc(doc(db, 'p2pRooms', 'anon-room'), {
          ownerUid: uid,
          participants: [uid],
          isPrivate: false,
          status: 'waiting',
          createdAt: Date.now(),
        })
      );
    });

    it('非匿名使用者可建立房間（ownerUid = 自己）', async () => {
      const token = await createTestUser(UID_OWNER);
      const { db, uid } = await signInWithToken('creator', token);
      await setDoc(doc(db, 'p2pRooms', 'valid-room'), {
        ownerUid: uid,
        participants: [uid],
        isPrivate: false,
        status: 'waiting',
        createdAt: Date.now(),
      });
      const snap = await adminDb().collection('p2pRooms').doc('valid-room').get();
      expect(snap.exists).toBe(true);
    });

    it('不可建立 ownerUid 為他人的房間', async () => {
      const token = await createTestUser(UID_MEMBER);
      const { db } = await signInWithToken('member', token);
      await assertDenied(() =>
        setDoc(doc(db, 'p2pRooms', 'spoof-room'), {
          ownerUid: UID_OWNER,     // ← 偽造他人為 owner
          participants: [UID_MEMBER],
          isPrivate: false,
          status: 'waiting',
          createdAt: Date.now(),
        })
      );
    });
  })
);

describe(
  'Firestore Rules: /p2pRooms — 更新',
  withEmulator(() => {
    beforeEach(async () => {
      await clearEmulatorData();
      await adminDb().collection('p2pRooms').doc(ROOM_ID).set({
        ownerUid: UID_OWNER,
        participants: [UID_OWNER],
        isPrivate: false,
        status: 'waiting',
        createdAt: Date.now(),
      });
    });

    it('房主可更新房間狀態', async () => {
      const token = await createTestUser(UID_OWNER);
      const { db } = await signInWithToken('owner', token);
      await updateDoc(doc(db, 'p2pRooms', ROOM_ID), { status: 'open' });
    });

    it('陌生人不可更新房間', async () => {
      const token = await createTestUser(UID_STRANGER);
      const { db } = await signInWithToken('stranger', token);
      await assertDenied(() =>
        updateDoc(doc(db, 'p2pRooms', ROOM_ID), { status: 'closed' })
      );
    });
  })
);

// ─────────────────────────────────────────────────────────────────────────
// 4. /p2pRooms/{roomId}/signals/{signalId}
// ─────────────────────────────────────────────────────────────────────────

describe(
  'Firestore Rules: signals subcollection',
  withEmulator(() => {
    beforeEach(async () => {
      await clearEmulatorData();
      await adminDb().collection('p2pRooms').doc(ROOM_ID).set({
        ownerUid: UID_OWNER,
        participants: [UID_OWNER, UID_MEMBER],
        isPrivate: false,
        status: 'open',
        createdAt: Date.now(),
      });
      // 預置一筆 signal（用 admin）
      await adminDb()
        .collection('p2pRooms').doc(ROOM_ID)
        .collection('signals').doc('sig-001')
        .set({ from: UID_OWNER, to: UID_MEMBER, type: 'offer', payload: {}, createdAt: Date.now() });
    });

    it('已登入使用者可讀取 signals', async () => {
      const token = await createTestUser(UID_MEMBER);
      const { db } = await signInWithToken('member', token);
      const snap = await getDoc(doc(db, 'p2pRooms', ROOM_ID, 'signals', 'sig-001'));
      expect(snap.exists()).toBe(true);
    });

    it('已登入使用者可新增 signal', async () => {
      const token = await createTestUser(UID_MEMBER);
      const { db } = await signInWithToken('member-sig', token);
      await addDoc(
        collection(db, 'p2pRooms', ROOM_ID, 'signals'),
        { from: UID_MEMBER, to: UID_OWNER, type: 'answer', payload: {}, createdAt: serverTimestamp() }
      );
    });

    it('不可更新 signal（append-only 規則）', async () => {
      const token = await createTestUser(UID_OWNER);
      const { db } = await signInWithToken('owner-sig', token);
      await assertDenied(() =>
        updateDoc(doc(db, 'p2pRooms', ROOM_ID, 'signals', 'sig-001'), { type: 'ice' })
      );
    });

    it('不可刪除 signal（append-only 規則）', async () => {
      const token = await createTestUser(UID_OWNER);
      const { db } = await signInWithToken('owner-del', token);
      await assertDenied(() =>
        deleteDoc(doc(db, 'p2pRooms', ROOM_ID, 'signals', 'sig-001'))
      );
    });
  })
);

// ─────────────────────────────────────────────────────────────────────────
// 5. /p2pRooms/{roomId}/messages/{messageId}
// ─────────────────────────────────────────────────────────────────────────

describe(
  'Firestore Rules: messages subcollection',
  withEmulator(() => {
    beforeEach(async () => {
      await clearEmulatorData();
      await adminDb().collection('p2pRooms').doc(ROOM_ID).set({
        ownerUid: UID_OWNER,
        participants: [UID_OWNER, UID_MEMBER],
        isPrivate: false,
        status: 'open',
        createdAt: Date.now(),
      });
      await adminDb()
        .collection('p2pRooms').doc(ROOM_ID)
        .collection('messages').doc('msg-001')
        .set({ from: UID_OWNER, content: 'hello', timestamp: Date.now(), edited: false, deleted: false });
    });

    it('房間參與者可讀取 messages', async () => {
      const token = await createTestUser(UID_MEMBER);
      const { db } = await signInWithToken('member-msg', token);
      const snap = await getDoc(doc(db, 'p2pRooms', ROOM_ID, 'messages', 'msg-001'));
      expect(snap.exists()).toBe(true);
    });

    it('非參與者不可讀取 messages', async () => {
      const token = await createTestUser(UID_STRANGER);
      const { db } = await signInWithToken('stranger-msg', token);
      await assertDenied(() =>
        getDoc(doc(db, 'p2pRooms', ROOM_ID, 'messages', 'msg-001'))
      );
    });

    it('參與者可新增 message', async () => {
      const token = await createTestUser(UID_MEMBER);
      const { db } = await signInWithToken('member-create', token);
      await addDoc(
        collection(db, 'p2pRooms', ROOM_ID, 'messages'),
        { from: UID_MEMBER, content: 'world', timestamp: serverTimestamp(), edited: false, deleted: false }
      );
    });

    it('不可更新 message（immutable 規則）', async () => {
      const token = await createTestUser(UID_OWNER);
      const { db } = await signInWithToken('owner-update', token);
      await assertDenied(() =>
        updateDoc(doc(db, 'p2pRooms', ROOM_ID, 'messages', 'msg-001'), { content: 'edited' })
      );
    });
  })
);

// ─────────────────────────────────────────────────────────────────────────
// 6. catch-all deny rule
// ─────────────────────────────────────────────────────────────────────────

describe(
  'Firestore Rules: catch-all deny',
  withEmulator(() => {
    it('任意使用者不可讀寫未定義的集合', async () => {
      const token = await createTestUser(UID_OWNER);
      const { db } = await signInWithToken('owner-catch', token);
      await assertDenied(() =>
        setDoc(doc(db, 'sensitiveCollection', 'doc'), { data: 'secret' })
      );
      await assertDenied(() =>
        getDoc(doc(db, 'sensitiveCollection', 'doc'))
      );
    });
  })
);
