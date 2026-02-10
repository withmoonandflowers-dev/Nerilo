import * as functions from 'firebase-functions';
import * as admin from 'firebase-admin';
import twilio from 'twilio';

admin.initializeApp();

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

  // 設定 custom claims
  await admin.auth().setCustomUserClaims(uid, { role });

  return { success: true, uid, role };
});

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

  try {
    const client = twilio(twilioAccountSid, twilioAuthToken);
    const token = await client.tokens.create();

    const iceServers = [
      ...defaultServers,
      ...token.iceServers.map((server: any) => ({
        urls: server.url,
        username: server.username,
        credential: server.credential,
      })),
    ];

    return { iceServers };
  } catch (error) {
    console.error('Error getting Twilio ICE servers:', error);
    // 發生錯誤時返回預設 servers
    return { iceServers: defaultServers };
  }
});



