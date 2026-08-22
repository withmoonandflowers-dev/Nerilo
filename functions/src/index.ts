import * as functions from 'firebase-functions';
import * as admin from 'firebase-admin';
import twilio from 'twilio';
import { decideQuota, type QuotaState } from './quota-core';

admin.initializeApp();

// Scheduled cleanup 必須由入口 re-export 才會成為可部署 Function。
export {
  cleanupExpiredRooms,
  cleanupStaleSignals,
  cleanupExpiredInbox,
} from './cleanupRooms';

// 設定使用者角色
export const setRole = functions.https.onCall(async (data, context) => {
  // 驗證使用者已登入且為 admin
  if (!context.auth) {
    throw new functions.https.HttpsError('unauthenticated', 'User must be authenticated');
  }

  const callerUid = context.auth.uid;
  const callerToken = await admin.auth().getUser(callerUid);
  const callerRole = callerToken.customClaims?.role;

  if (callerRole !== 'admin') {
    throw new functions.https.HttpsError('permission-denied', 'Only admins can set roles');
  }

  const { uid, role } = data;
  if (!uid || !role) {
    throw new functions.https.HttpsError('invalid-argument', 'uid and role are required');
  }

  if (!['guest', 'user', 'admin'].includes(role)) {
    throw new functions.https.HttpsError('invalid-argument', 'Invalid role');
  }

  // L-1：必須保留既有 claims。此前直接寫 { role } 會清掉 plan——
  // 把付費使用者靜默降級（與 ls-webhook 的降級傷害同類）。
  // setCustomUserClaims 是整份覆寫，沒有 merge 語義，故須自行展開。
  const target = await admin.auth().getUser(uid);
  const existingClaims = target.customClaims ?? {};
  await admin.auth().setCustomUserClaims(uid, { ...existingClaims, role });

  return { success: true, uid, role };
});

/**
 * M-7：TURN 憑證配額（每使用者固定視窗計數）。
 *
 * Twilio TURN 是按中繼流量計費的，發憑證等於發帳單授權。此前只檢查「有沒有登入」，
 * 匿名登入即可通過，且無速率限制——攻擊者可大量建匿名帳號無限索取。
 * 這裡用 Firestore 固定視窗計數把每個帳號的發放次數封頂。
 * 集合 iceQuota 只由 admin SDK 讀寫，客戶端被 firestore.rules 的 catch-all 擋住。
 */
const ICE_QUOTA_WINDOW_MS = 60 * 60 * 1000;
const ICE_QUOTA_MAX = 60;

async function consumeIceQuota(uid: string): Promise<boolean> {
  const ref = admin.firestore().collection('iceQuota').doc(uid);
  return admin.firestore().runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const decision = decideQuota(
      snap.exists ? (snap.data() as Partial<QuotaState>) : undefined,
      Date.now(),
      ICE_QUOTA_WINDOW_MS,
      ICE_QUOTA_MAX
    );
    if (decision.allowed) tx.set(ref, decision.state, { merge: true });
    return decision.allowed;
  });
}

// 取得 ICE servers（可選：使用 Twilio）
export const getIceServers = functions.https.onCall(async (data, context) => {
  // 驗證使用者已登入
  if (!context.auth) {
    throw new functions.https.HttpsError('unauthenticated', 'User must be authenticated');
  }

  const defaultServers = [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
  ];

  // 如果沒有設定 Twilio，返回預設 STUN servers
  const twilioAccountSid = functions.config().twilio?.account_sid;
  const twilioAuthToken = functions.config().twilio?.auth_token;

  if (!twilioAccountSid || !twilioAuthToken) {
    return { iceServers: defaultServers };
  }

  // M-7：以下才會真的動用計費資源，故防濫用檢查放在這一段之後。
  // 匿名帳號不發 TURN 憑證（反女巫，與 firestore.rules 各處的既有口徑一致）。
  if (context.auth.token.firebase?.sign_in_provider === 'anonymous') {
    console.warn('[getIceServers] Anonymous caller denied TURN credentials', { uid: context.auth.uid });
    return { iceServers: defaultServers };
  }

  // 超額時退回 STUN（不擲錯）：呼叫端仍拿得到可用的 ICE 設定，
  // 只是不發放計費的 TURN 憑證——把成本封頂，同時不直接斷掉連線能力。
  if (!(await consumeIceQuota(context.auth.uid))) {
    console.warn('[getIceServers] TURN quota exhausted for user', {
      uid: context.auth.uid, max: ICE_QUOTA_MAX,
    });
    return { iceServers: defaultServers };
  }

  try {
    const client = twilio(twilioAccountSid, twilioAuthToken);
    const token = await client.tokens.create();

    const iceServers = [
      ...defaultServers,
      ...token.iceServers
        .filter((server) => server.url)
        .map((server) => ({
          urls: server.url!,
          username: server.username ?? '',
          credential: server.credential ?? '',
        })),
    ];

    return { iceServers };
  } catch (error) {
    console.error('Error getting Twilio ICE servers:', error);
    // 發生錯誤時返回預設 servers
    return { iceServers: defaultServers };
  }
});


