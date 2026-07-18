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
  doc, getDoc, getDocs, setDoc, addDoc, updateDoc, deleteDoc,
  collection, serverTimestamp, Timestamp,
} from 'firebase/firestore';
import {
  clearEmulatorData,
  createTestUser,
  adminDb,
} from './helpers/admin-client';
import {
  signInWithToken,
  signInAnon,
  unauthDb,
  cleanupWebClients,
} from './helpers/web-client';

// ── Emulator 可用性檢查 ───────────────────────────────────────────────────

async function isEmulatorRunning(): Promise<boolean> {
  // 若 emulator-env.ts setupFile 已設定 FIRESTORE_EMULATOR_HOST，
  // 直接使用 Node http 模組探測（避免 Vitest worker_threads + Node 24 的 fetch 相容問題）
  const host = process.env['FIRESTORE_EMULATOR_HOST'];
  if (!host) return false;

  const [hostname, portStr] = host.split(':');
  const port = Number(portStr);

  const http = await import('node:http');
  return new Promise<boolean>((resolve) => {
    console.log(`[isEmulatorRunning] Checking http://${hostname}:${port}/`);
    const req = http.get({ hostname, port, path: '/', timeout: 3000 }, (res) => {
      console.log(`[isEmulatorRunning] Response status: ${res.statusCode}`);
      resolve(true);
      res.resume();
    });
    req.on('error', (err) => {
      console.log(`[isEmulatorRunning] Error: ${(err as NodeJS.ErrnoException).code || err.message}`);
      resolve(false);
    });
    req.on('timeout', () => { req.destroy(); resolve(false); });
  });
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

// 同步檢查環境變數：setupFiles (emulator-env.ts) 在測試收集前已執行
// 若 FIRESTORE_EMULATOR_HOST 已設定，假設 emulator 可用
// 實際連線失敗會在各測試中拋錯而非靜默 skip
let emulatorAvailable = !!process.env['FIRESTORE_EMULATOR_HOST'];

beforeAll(async () => {
  if (emulatorAvailable) {
    // 再用 HTTP 探測確認（若失敗則降級）
    emulatorAvailable = await isEmulatorRunning();
  }
  if (!emulatorAvailable) {
    console.warn(
      '\n⚠  Firebase Emulator 未偵測到（' + (process.env['FIRESTORE_EMULATOR_HOST'] || '未設定') + '）。\n' +
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
        { from: UID_MEMBER, to: UID_OWNER, type: 'answer', payload: {}, createdAt: serverTimestamp(), expiresAt: Timestamp.fromMillis(Date.now() + 300_000) }
      );
    });

    it('缺 expiresAt 的 signal 會被拒絕', async () => {
      const token = await createTestUser(UID_MEMBER);
      const { db } = await signInWithToken('member-sig-no-expiry', token);
      await assertDenied(() => addDoc(
        collection(db, 'p2pRooms', ROOM_ID, 'signals'),
        { from: UID_MEMBER, to: UID_OWNER, type: 'answer', payload: {}, createdAt: serverTimestamp() }
      ));
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
        // createdAt 為 messages 規則的必要欄位（防 replay ±30s 窗）；production 的
        // sendMessageViaFirestore 有寫，此測試原本漏了 → 修正對齊。
        { from: UID_MEMBER, content: 'world', createdAt: serverTimestamp(), expiresAt: Timestamp.fromMillis(Date.now() + 86_400_000), timestamp: serverTimestamp(), edited: false, deleted: false }
      );
    });

    it('超過 25 小時的 message expiresAt 會被拒絕', async () => {
      const token = await createTestUser(UID_MEMBER);
      const { db } = await signInWithToken('member-message-long-expiry', token);
      await assertDenied(() => addDoc(
        collection(db, 'p2pRooms', ROOM_ID, 'messages'),
        {
          from: UID_MEMBER,
          content: 'world',
          createdAt: serverTimestamp(),
          expiresAt: Timestamp.fromMillis(Date.now() + 26 * 60 * 60 * 1000),
          timestamp: serverTimestamp(),
          edited: false,
          deleted: false,
        }
      ));
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

// ─────────────────────────────────────────────────────────────────────────
// 7. /relayDirectory/{ownerUid}（ADR-0023 P4-A 全站節點名冊）
// ─────────────────────────────────────────────────────────────────────────

describe(
  'Firestore Rules: /relayDirectory',
  withEmulator(() => {
    const freshAnnounce = (ownerUid: string, nodeId = 'node-abcdef12') => ({
      nodeId,
      ownerUid,
      announcedAt: Date.now(),
      capacity: 1,
    });

    beforeEach(async () => {
      await clearEmulatorData();
    });

    it('非匿名使用者可宣告自己那格', async () => {
      const token = await createTestUser(UID_OWNER);
      const { db, uid } = await signInWithToken('rd-owner', token);
      await setDoc(doc(db, 'relayDirectory', uid), freshAnnounce(uid));
      const snap = await getDoc(doc(db, 'relayDirectory', uid));
      expect(snap.exists()).toBe(true);
    });

    it('不能寫別人那格（docId ≠ auth.uid）', async () => {
      const token = await createTestUser(UID_OWNER);
      const { db } = await signInWithToken('rd-owner2', token);
      await assertDenied(() =>
        setDoc(doc(db, 'relayDirectory', UID_STRANGER), freshAnnounce(UID_STRANGER))
      );
    });

    it('ownerUid 欄位與 docId 不符 → 拒絕（防冒名）', async () => {
      const token = await createTestUser(UID_OWNER);
      const { db, uid } = await signInWithToken('rd-owner3', token);
      await assertDenied(() =>
        setDoc(doc(db, 'relayDirectory', uid), { ...freshAnnounce(uid), ownerUid: UID_STRANGER })
      );
    });

    it('匿名使用者不可宣告（反女巫）', async () => {
      const { db, uid } = await signInAnon('rd-anon');
      await assertDenied(() =>
        setDoc(doc(db, 'relayDirectory', uid), freshAnnounce(uid))
      );
    });

    it('announcedAt 過舊（>60s）→ 拒絕', async () => {
      const token = await createTestUser(UID_OWNER);
      const { db, uid } = await signInWithToken('rd-stale', token);
      await assertDenied(() =>
        setDoc(doc(db, 'relayDirectory', uid), { ...freshAnnounce(uid), announcedAt: Date.now() - 120_000 })
      );
    });

    it('任何登入者可讀名冊；未登入不可讀', async () => {
      // owner seed 一則
      const ownerToken = await createTestUser(UID_OWNER);
      const owner = await signInWithToken('rd-read-owner', ownerToken);
      await setDoc(doc(owner.db, 'relayDirectory', owner.uid), freshAnnounce(owner.uid));

      // 另一登入者可讀
      const otherToken = await createTestUser(UID_MEMBER);
      const other = await signInWithToken('rd-read-other', otherToken);
      const snap = await getDoc(doc(other.db, 'relayDirectory', owner.uid));
      expect(snap.exists()).toBe(true);

      // 未登入不可讀
      await assertDenied(() => getDoc(doc(unauthDb('rd-unauth'), 'relayDirectory', owner.uid)));
    });

    it('只能撤自己那格', async () => {
      const ownerToken = await createTestUser(UID_OWNER);
      const owner = await signInWithToken('rd-del-owner', ownerToken);
      await setDoc(doc(owner.db, 'relayDirectory', owner.uid), freshAnnounce(owner.uid));

      // 別人不能刪我的
      const otherToken = await createTestUser(UID_MEMBER);
      const other = await signInWithToken('rd-del-other', otherToken);
      await assertDenied(() => deleteDoc(doc(other.db, 'relayDirectory', owner.uid)));

      // 自己可以刪自己的
      await deleteDoc(doc(owner.db, 'relayDirectory', owner.uid));
      const snap = await getDoc(doc(owner.db, 'relayDirectory', owner.uid));
      expect(snap.exists()).toBe(false);
    });
  })
);

// ─────────────────────────────────────────────────────────────────────────
// 8. /relaySignals/{channelId}（ADR-0023 P4-B 陌生節點站級 signaling）
// ─────────────────────────────────────────────────────────────────────────

describe(
  'Firestore Rules: /relaySignals',
  withEmulator(() => {
    const chanId = (a: string, b: string) => [a, b].sort().join('__');

    beforeEach(async () => {
      await clearEmulatorData();
    });

    it('雙方之一可開 pairwise 通道', async () => {
      const { db, uid } = await signInWithToken('rs-open', await createTestUser(UID_OWNER));
      const cid = chanId(uid, UID_MEMBER);
      await setDoc(doc(db, 'relaySignals', cid), {
        participants: [uid, UID_MEMBER].sort(),
        createdAt: serverTimestamp(),
        expiresAt: Timestamp.fromMillis(Date.now() + 600_000),
      });
      expect((await getDoc(doc(db, 'relaySignals', cid))).exists()).toBe(true);
    });

    it('非 participant 不可開通道（participants 不含自己）', async () => {
      const { db } = await signInWithToken('rs-notpart', await createTestUser(UID_OWNER));
      const cid = chanId(UID_MEMBER, UID_STRANGER);
      await assertDenied(() =>
        setDoc(doc(db, 'relaySignals', cid), {
          participants: [UID_MEMBER, UID_STRANGER].sort(),
          createdAt: serverTimestamp(),
          expiresAt: Timestamp.fromMillis(Date.now() + 600_000),
        })
      );
    });

    it('匿名不可開通道（反女巫）', async () => {
      const { db, uid } = await signInAnon('rs-anon');
      const cid = chanId(uid, UID_MEMBER);
      await assertDenied(() =>
        setDoc(doc(db, 'relaySignals', cid), {
          participants: [uid, UID_MEMBER].sort(),
          createdAt: serverTimestamp(),
          expiresAt: Timestamp.fromMillis(Date.now() + 600_000),
        })
      );
    });

    it('participant 可寫/讀 signal；from 必須==自己；第三方不可讀', async () => {
      const owner = await signInWithToken('rs-sig-owner', await createTestUser(UID_OWNER));
      const cid = chanId(owner.uid, UID_MEMBER);
      await setDoc(doc(owner.db, 'relaySignals', cid), {
        participants: [owner.uid, UID_MEMBER].sort(),
        createdAt: serverTimestamp(),
        expiresAt: Timestamp.fromMillis(Date.now() + 600_000),
      });

      // owner 寫 offer（from==自己）→ OK
      await addDoc(collection(owner.db, 'relaySignals', cid, 'signals'), {
        from: owner.uid, type: 'offer', payload: { type: 'offer', sdp: 'x' }, createdAt: serverTimestamp(),
        expiresAt: Timestamp.fromMillis(Date.now() + 300_000),
      });

      // 對方（member）可讀 signals
      const member = await signInWithToken('rs-sig-member', await createTestUser(UID_MEMBER));
      const sigs = await getDocs(collection(member.db, 'relaySignals', cid, 'signals'));
      expect(sigs.empty).toBe(false);

      // from ≠ 自己 → 拒（防冒名代送）
      await assertDenied(() =>
        addDoc(collection(member.db, 'relaySignals', cid, 'signals'), {
          from: owner.uid, type: 'ice', payload: {}, createdAt: serverTimestamp(),
          expiresAt: Timestamp.fromMillis(Date.now() + 300_000),
        })
      );

      // 第三方（stranger）不可讀該通道 signals
      const stranger = await signInWithToken('rs-sig-stranger', await createTestUser(UID_STRANGER));
      await assertDenied(() => getDocs(collection(stranger.db, 'relaySignals', cid, 'signals')));
    });
  })
);

// ── 房間容量分層（Spec 011 Q7：Free 5／Pro 10，token.plan 由 firebase-admin 寫入）──

describe(
  'Firestore Rules: p2pRooms 容量分層（token.plan）',
  withEmulator(() => {
    beforeEach(clearEmulatorData);

    function roomDoc(uid: string, maxParticipants?: number) {
      return {
        ownerUid: uid,
        participants: [uid],
        isPrivate: false,
        status: 'waiting',
        createdAt: Date.now(),
        ...(maxParticipants !== undefined ? { maxParticipants } : {}),
      };
    }

    it('Free 使用者可建缺省房（無 maxParticipants 欄位＝5）', async () => {
      const token = await createTestUser(UID_OWNER);
      const { db, uid } = await signInWithToken('cap-free-default', token);
      await setDoc(doc(db, 'p2pRooms', 'cap-free-default'), roomDoc(uid));
    });

    it('Free 使用者可建 5 人房、不可建 6 人房', async () => {
      const token = await createTestUser(UID_OWNER);
      const { db, uid } = await signInWithToken('cap-free', token);
      await setDoc(doc(db, 'p2pRooms', 'cap-free-5'), roomDoc(uid, 5));
      await assertDenied(() =>
        setDoc(doc(db, 'p2pRooms', 'cap-free-6'), roomDoc(uid, 6))
      );
    });

    it('⚠ Pro 使用者可建 10 人房（關鍵權益）、仍不可超過 10', async () => {
      const token = await createTestUser(UID_OWNER, { plan: 'pro' });
      const { db, uid } = await signInWithToken('cap-pro', token);
      await setDoc(doc(db, 'p2pRooms', 'cap-pro-10'), roomDoc(uid, 10));
      await assertDenied(() =>
        setDoc(doc(db, 'p2pRooms', 'cap-pro-11'), roomDoc(uid, 11))
      );
    });

    it('plan=free 的 claim 值不解鎖大房（只認 pro）', async () => {
      const token = await createTestUser(UID_OWNER, { plan: 'free' });
      const { db, uid } = await signInWithToken('cap-claimfree', token);
      await assertDenied(() =>
        setDoc(doc(db, 'p2pRooms', 'cap-claimfree-8'), roomDoc(uid, 8))
      );
    });

    it('容量建後不可變（房主 Pro 也不行）', async () => {
      const token = await createTestUser(UID_OWNER, { plan: 'pro' });
      const { db, uid } = await signInWithToken('cap-immutable', token);
      await setDoc(doc(db, 'p2pRooms', 'cap-imm'), roomDoc(uid, 10));
      await assertDenied(() =>
        updateDoc(doc(db, 'p2pRooms', 'cap-imm'), { maxParticipants: 5 })
      );
    });
  })
);
