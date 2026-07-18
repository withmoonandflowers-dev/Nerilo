/**
 * 每通道安全分級標籤（Spec 012 / GX3；原則出處 ADR-0010 Decision 1-2）
 *
 * 安全是「通道標籤＋應用最低等級宣告」，不是全域布林：
 *  - 每個傳輸通道宣告安全等級（e2ee > sign-only > plaintext，內容層口徑——
 *    傳輸層加密如 DTLS/TLS 不計入等級，因為它保護不到伺服器與中繼之後）。
 *  - 應用層（資料流）宣告最低可接受等級；路由不得把資料送往低於宣告等級的通道。
 *  - 預設最低等級是 e2ee；降級必須顯式（使用者確認），且 UI 可見（ADR-0026 R2）。
 *
 * 本模組是純型別契約與判定原語，零框架、零 I/O：
 *  - ham 頻段等未來 RF 通道（法規禁加密 → 恆 sign-only）接入時只需宣告標籤，
 *    分級語義在此已定，不必翻修契約（ADR-0010 Context 的破壞式變更風險預防）。
 *  - R2 的房級三態 EncryptionState 改為本模組的衍生值（deriveEncryptionState），
 *    「exchanging 逾時 → 視同 plaintext 走 fail-visible」的升級規則也定義於此（Spec 012 Q2）。
 *  - SDK 表面暫不匯出；M4 平台抽取時隨 transport 契約一併上（避免 0.x 提前鎖 API）。
 */

import type { EncryptionState } from '../../types';

/** 通道安全等級（內容層）：e2ee=密文＋簽章；sign-only=可讀但可驗真；plaintext=無保護。 */
export type SecurityLevel = 'e2ee' | 'sign-only' | 'plaintext';

const RANK: Record<SecurityLevel, number> = { e2ee: 2, 'sign-only': 1, plaintext: 0 };

/** actual 是否達到 min 宣告的最低等級。 */
export function meetsMinimum(actual: SecurityLevel, min: SecurityLevel): boolean {
  return RANK[actual] >= RANK[min];
}

/** 現有通道種類（RF 通道未來以同一契約宣告，不在此列舉）。 */
export type ChannelKind = 'gossip' | 'firestore-fallback' | 'presence' | 'courier';

/**
 * 通道→等級判定（現況盤點見 Spec 012 §1.2 缺口六的表）：
 *  - gossip：紀錄恆有 ECDSA 簽章；房間金鑰就緒＝密文（e2ee），未就緒＝可讀（sign-only）。
 *  - firestore-fallback：密文信封＝e2ee；明文 body＝plaintext（無簽章，TLS 只到伺服器）。
 *  - presence（typing 暫態）：DTLS-only、無簽章、不進日誌 → plaintext（誠實標示）。
 *  - courier：只代管密文＋簽章（收側拒收明文使此宣告可驗證，見 courierEligibility）→ e2ee。
 */
export function channelSecurityLevel(
  kind: ChannelKind,
  ctx: { roomKeyReady?: boolean; encryptedBody?: boolean } = {}
): SecurityLevel {
  switch (kind) {
    case 'gossip':
      return ctx.roomKeyReady ? 'e2ee' : 'sign-only';
    case 'firestore-fallback':
      return ctx.encryptedBody ? 'e2ee' : 'plaintext';
    case 'presence':
      return 'plaintext';
    case 'courier':
      return 'e2ee';
  }
}

/**
 * 送出閘決策（Q2 送出閘與 Q6 最低等級路由閘收斂成的同一原語）：
 *  - allow：通道現況達最低等級 → 放行。
 *  - hold：未達但可望改善（金鑰交換中）→ 暫扣，就緒自動補送。
 *  - confirm-degrade：未達且已定局（真明文房或交換逾時）→ 必須使用者顯式確認才可降級送出。
 */
export type SendGateDecision = 'allow' | 'hold' | 'confirm-degrade';

export function sendGateDecision(state: EncryptionState, min: SecurityLevel): SendGateDecision {
  // gossip 通道在各狀態下的內容層等級：encrypted=e2ee；其餘＝sign-only（簽章恆有、內容可讀）
  const level: SecurityLevel = state === 'encrypted' ? 'e2ee' : 'sign-only';
  if (meetsMinimum(level, min)) return 'allow';
  return state === 'exchanging' ? 'hold' : 'confirm-degrade';
}

/**
 * R2 房級三態的衍生（EncryptionState 不再由引擎手寫 if 鏈，統一由標籤事實推導）：
 *  - 未初始化 → 'exchanging'（未知，不誤報明文）。
 *  - 金鑰協調不可用（ECDH 缺席）→ 'plaintext'（真降級，房間永久無法加密）。
 *  - 金鑰就緒 → 'encrypted'。
 *  - 交換逾時仍未就緒 → 'plaintext'（fail-visible 升級，Spec 012 Q2：逾時後視同明文房，
 *    送訊需阻斷式確認；金鑰事後到位則衍生值自動回到 encrypted，狀態可恢復）。
 *  - 其餘 → 'exchanging'。
 */
export function deriveEncryptionState(args: {
  initialized: boolean;
  coordinatorActive: boolean;
  roomKeyReady: boolean;
  exchangeTimedOut: boolean;
}): EncryptionState {
  if (!args.initialized) return 'exchanging';
  if (!args.coordinatorActive) return 'plaintext';
  if (args.roomKeyReady) return 'encrypted';
  return args.exchangeTimedOut ? 'plaintext' : 'exchanging';
}
