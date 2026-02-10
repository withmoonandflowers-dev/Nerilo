"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.getIceServers = exports.setRole = void 0;
const functions = __importStar(require("firebase-functions"));
const admin = __importStar(require("firebase-admin"));
const twilio_1 = __importDefault(require("twilio"));
admin.initializeApp();
// 設定使用者角色
exports.setRole = functions.https.onCall(async (data, context) => {
    var _a;
    // 驗證使用者已登入且為 admin
    if (!context.auth) {
        throw new functions.https.HttpsError('unauthenticated', 'User must be authenticated');
    }
    const callerUid = context.auth.uid;
    const callerToken = await admin.auth().getUser(callerUid);
    const callerRole = (_a = callerToken.customClaims) === null || _a === void 0 ? void 0 : _a.role;
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
exports.getIceServers = functions.https.onCall(async (data, context) => {
    var _a, _b;
    // 驗證使用者已登入
    if (!context.auth) {
        throw new functions.https.HttpsError('unauthenticated', 'User must be authenticated');
    }
    const defaultServers = [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' },
    ];
    // 如果沒有設定 Twilio，返回預設 STUN servers
    const twilioAccountSid = (_a = functions.config().twilio) === null || _a === void 0 ? void 0 : _a.account_sid;
    const twilioAuthToken = (_b = functions.config().twilio) === null || _b === void 0 ? void 0 : _b.auth_token;
    if (!twilioAccountSid || !twilioAuthToken) {
        return { iceServers: defaultServers };
    }
    try {
        const client = (0, twilio_1.default)(twilioAccountSid, twilioAuthToken);
        const token = await client.tokens.create();
        const iceServers = [
            ...defaultServers,
            ...token.iceServers.map((server) => ({
                urls: server.url,
                username: server.username,
                credential: server.credential,
            })),
        ];
        return { iceServers };
    }
    catch (error) {
        console.error('Error getting Twilio ICE servers:', error);
        // 發生錯誤時返回預設 servers
        return { iceServers: defaultServers };
    }
});
//# sourceMappingURL=index.js.map