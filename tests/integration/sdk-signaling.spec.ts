/**
 * createFirestoreSignaling 整合測試（Spec 015，T6 的可達成部分）。
 *
 * 證明「第三方拿得到的那個 signaling 出口，在**真實 rules** 下真的能用」：
 * 一端用 SDK 公開出口送 SDP，另一端用原生 Web SDK（模擬別台裝置的另一個帳號）收得到，
 * 反向亦然；且非參與者被 rules 擋下。
 *
 * 為什麼不是 spec 原本寫的「block-brawl 跨設定檔對戰」：實作時查出硬阻礙——
 * `firestore.rules:144` 規定建房必須是**非匿名**帳號（`sign_in_provider != "anonymous"`），
 * 而 signals 的 rules 又要求呼叫者在該房的 participants 內。也就是說任何第三方要用這個
 * signaling，都得先有一個 Nerilo 房間、且房主得是註冊帳號。遊戲大廳的玩家是匿名的，
 * 這條路走不通。缺口記在 Spec 014（房間目錄契約）與 015 的 T6 條目。
 *
 * 這支測試因此把範圍收在「出口本身可用」，並如實標明它**沒有**證明跨裝置對戰。
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { addDoc, getDocs, collection, Timestamp } from 'firebase/firestore';
import { signInWithCustomToken } from 'firebase/auth';
import { clearEmulatorData, createTestUser, adminDb } from './helpers/admin-client';
import { signInWithToken, cleanupWebClients } from './helpers/web-client';

const OWNER = 'sdk-owner';
const GUEST = 'sdk-guest';
const OUTSIDER = 'sdk-outsider';
const RUN = Boolean(process.env['FIRESTORE_EMULATOR_HOST']);

describe('SDK createFirestoreSignaling（真實 rules 下的第三方可用性）', () => {
  // 每支測試一間新房：signals 是 append-only，而 web SDK 的本地快取在 admin 端刪除後
  // 仍會於 onSnapshot 首次快照回放已刪文件（實測踩到，誤判成產品 bug）。換房間最乾淨。
  let roomSeq = 0;
  let ROOM_ID = '';
  let ownerToken = '';
  let guestToken = '';
  let outsiderToken = '';

  beforeAll(async () => {
    if (!RUN) return;
    ownerToken = await createTestUser(OWNER);
    guestToken = await createTestUser(GUEST);
    outsiderToken = await createTestUser(OUTSIDER);
  });

  afterAll(async () => {
    if (!RUN) return;
    await cleanupWebClients();
    await clearEmulatorData();
  });

  beforeEach(async () => {
    if (!RUN) return;
    ROOM_ID = `sdk-signaling-room-${++roomSeq}`;
    // 用 admin 直接 seed 房間：鏡射 Nerilo app 由註冊帳號建房、兩人都在 participants
    // 的那個「已成局」狀態。繞過 rules 是刻意的——本測試要驗的是 signals 這一層。
    await adminDb().collection('p2pRooms').doc(ROOM_ID).set({
      roomId: ROOM_ID,
      ownerUid: OWNER,
      participants: [OWNER, GUEST],
      status: 'open',
      isPrivate: false,
      createdAt: Date.now(),
    });
  });

  it.runIf(RUN)('SDK 出口送出的 signal，另一個帳號讀得到（rules 放行參與者）', async () => {
    const { createFirestoreSignaling } = await import('../../src/sdk/firestore');
    const { auth } = await import('../../src/config/firebase');
    await signInWithCustomToken(auth, ownerToken);

    const transport = createFirestoreSignaling()(ROOM_ID, 'inputs');
    await transport.send({
      from: OWNER,
      to: GUEST,
      type: 'offer',
      payload: { sdp: 'v=0 fake-offer' },
      channelLabel: 'inputs',
      createdAt: Date.now(),
    });

    // 另一端：不同 FirebaseApp、不同帳號（模擬另一台裝置）
    const guest = await signInWithToken('guest', guestToken);
    const snap = await getDocs(collection(guest.db, 'p2pRooms', ROOM_ID, 'signals'));
    const docs = snap.docs.map((d) => d.data());
    expect(docs).toHaveLength(1);
    expect(docs[0]!['from']).toBe(OWNER);
    expect(docs[0]!['type']).toBe('offer');
    // transport 自動補的 TTL 欄位（rules 強制要有，嵌入者不用自己帶）
    expect(docs[0]!['expiresAt']).toBeDefined();
  });

  it.runIf(RUN)('SDK 出口收得到對端寫入的 signal（subscribe 真的串到 Firestore）', async () => {
    const { createFirestoreSignaling } = await import('../../src/sdk/firestore');
    const { auth } = await import('../../src/config/firebase');
    await signInWithCustomToken(auth, ownerToken);

    const transport = createFirestoreSignaling()(ROOM_ID, 'inputs');
    const received: Record<string, unknown>[] = [];
    const off = transport.subscribe(Date.now() - 1000, (raw) => {
      received.push(raw as unknown as Record<string, unknown>);
    });

    const guest = await signInWithToken('guest2', guestToken);
    await addDoc(collection(guest.db, 'p2pRooms', ROOM_ID, 'signals'), {
      from: GUEST,
      to: OWNER,
      type: 'answer',
      payload: { sdp: 'v=0 fake-answer' },
      channelLabel: 'inputs',
      createdAt: Timestamp.now(),
      expiresAt: Timestamp.fromMillis(Date.now() + 5 * 60 * 1000),
    });

    await vi.waitFor(
      () => expect(received.some((r) => r['type'] === 'answer' && r['from'] === GUEST)).toBe(true),
      { timeout: 15_000 }
    );
    off();
  });

  it.runIf(RUN)('非參與者讀 signals 被 rules 擋下（出口沒有繞過授權）', async () => {
    const outsider = await signInWithToken('outsider', outsiderToken);
    await expect(
      getDocs(collection(outsider.db, 'p2pRooms', ROOM_ID, 'signals'))
    ).rejects.toThrow();
  });
});
