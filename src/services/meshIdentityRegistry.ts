/**
 * meshIdentityRegistry — meshIdentities 名冊寫入（自 RoomService 抽出）。
 *
 * 抽出理由：RoomService 是 god-file 棘輪祖父檔（fitness.architecture.spec），
 * Spec 005 T4 要加 introducedBy 欄位——新邏輯進新檔，不讓大檔更大。
 * 行為與抽出前逐字一致（驗證、重試、寫入形狀），僅新增 introducedBy 處理。
 */
import { doc, getDoc, updateDoc } from 'firebase/firestore';
import { db } from '../config/firebase';
import { logger } from '../utils/logger';

const isB64 = (s: string) => /^[A-Za-z0-9+/]+=*$/.test(s);

/**
 * 更新或添加小網狀架構的身分資訊。
 * firestore.rules 以「更新前 doc 的 participants 含自己」授權；三人幾乎同時進場時，
 * 本人的 join(arrayUnion) 可能尚未 server-commit，此刻寫入會失敗，以重試等 join 傳播。
 */
export async function updateMeshIdentity(
  roomId: string,
  firebaseUid: string,
  userId: string,
  pubKey: string,
  /** ECDH 公鑰（Base64 SPKI），供 keyx 成對封裝（ADR-0023 P2-②c）。可選（舊 client 不帶）。 */
  ecdhPubKey?: string,
  /** 介紹人 uid（Spec 005 T4 邀請連結會合）。可選；供他人對此成員耐心等 warm 中繼。 */
  introducedBy?: string
): Promise<void> {
  const roomDoc = doc(db, 'p2pRooms', roomId);

  // 驗證格式（純輸入檢查，不需重試）——訊息與抽出前逐字一致（有測試釘住語義）
  if (typeof userId !== 'string' || userId.length < 8 || userId.length > 64) {
    throw new Error('Invalid userId format: must be 8-64 characters');
  }
  if (typeof pubKey !== 'string' || pubKey.length < 40 || pubKey.length > 512) {
    throw new Error('Invalid pubKey format: must be 40-512 characters');
  }
  if (!isB64(pubKey)) {
    throw new Error('Invalid pubKey format: must be valid Base64');
  }
  if (ecdhPubKey !== undefined) {
    if (typeof ecdhPubKey !== 'string' || ecdhPubKey.length < 40 || ecdhPubKey.length > 512) {
      throw new Error('Invalid ecdhPubKey format: must be 40-512 characters');
    }
    if (!isB64(ecdhPubKey)) {
      throw new Error('Invalid ecdhPubKey format: must be valid Base64');
    }
  }

  const attempt = async (): Promise<void> => {
    const snap = await getDoc(roomDoc);
    if (!snap.exists()) throw new Error('房間不存在');
    const data = snap.data();
    const participants = data.participants || [];
    if (!participants.includes(firebaseUid)) {
      throw new Error('join-not-propagated'); // 可重試：join 尚未生效
    }
    // B6：以 dotted field path 只寫自己那一格，由 Firestore 在伺服器端原子合併。
    //
    // 此前是「讀整張 meshIdentities → 在本地插入自己 → 整份覆寫」。多人同時進場時
    // 人人拿著各自的舊快照覆寫整張表：後到者的寫入會刪掉快照中沒有的他人條目，
    // 於是被 meshIdentitiesChangeIsValid（affectedKeys 必須 ⊆ {自己}）判為
    // permission-denied。7-10 人同時進場時 5 次重試（約 2 秒）會耗盡 → 拋錯 →
    // MeshGossipManager.initialize() 一路往上拋（歷史事故 bb85879「三人同時入房必敗」
    // 當時的修法是加重試，沒有解決根因）。
    //
    // dotted path 不讀不改他人條目，天然無 lost update、也不再觸發該規則，
    // 上面的 getDoc 只剩「join 是否已傳播 / introducedBy 是否為房內成員」的驗證用途。
    const entry = {
      userId,
      pubKey,
      ...(ecdhPubKey ? { ecdhPubKey } : {}),
      // 介紹人必須是房內參與者才有意義（也擋垃圾值進名冊）
      ...(introducedBy && participants.includes(introducedBy) ? { introducedBy } : {}),
      joinedAt: Date.now(),
    };
    await updateDoc(roomDoc, {
      [`meshIdentities.${firebaseUid}`]: entry,
      topology: 'mesh', // 標記為 mesh 拓撲
    });
  };

  const MAX_ATTEMPTS = 5;
  for (let i = 0; i < MAX_ATTEMPTS; i++) {
    try {
      await attempt();
      break;
    } catch (err) {
      const code = (err as { code?: string }).code;
      const msg = (err as Error).message;
      const retryable = msg === 'join-not-propagated' || code === 'permission-denied';
      // 「房間不存在」與格式錯誤等不可重試——立即拋出
      if (msg === '房間不存在') throw err;
      if (!retryable || i === MAX_ATTEMPTS - 1) throw err;
      await new Promise((r) => setTimeout(r, 200 * (i + 1))); // 200/400/600/800ms
    }
  }

  logger.debug('[meshIdentityRegistry] Updated mesh identity', { roomId, firebaseUid, userId });
}
