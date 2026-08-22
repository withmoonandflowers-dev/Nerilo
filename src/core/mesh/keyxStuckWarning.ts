/**
 * keyx 受阻警告的判定（B5 可觀測性）。
 *
 * 抽出理由與 meshIdentityRegistry 相同：MeshGossipManager 逼近 god-file 行數上限
 * （fitness.architecture.spec 的 800 行閘門），新邏輯進新檔。純函式、零依賴、可單測。
 *
 * 為什麼需要這個警告：一位 participant 遲遲不註冊 mesh 身分，就足以讓整房永遠等不到
 * 房間金鑰，60 秒後退成「必須確認明文」。現場只會看到使用者被要求確認明文，
 * 日誌裡沒有任何線索指向真正的原因。
 */
import type { KeyxStatus, KeyxBlockReason } from './RoomKeyCoordinator';
import { logger } from '../../utils/logger';

/** 未被擋的狀態常值（無協調器＝明文房時的回覆）。 */
export const KEYX_NOT_BLOCKED: KeyxStatus = { reason: 'none', pendingMembers: 0, blockedForMs: 0 };

export interface StuckWarningDecision {
  /** 這次是否該吼 */
  warn: boolean;
  /** 更新後的「已吼過的原因」（呼叫端存回去） */
  nextWarnedReason: KeyxBlockReason | null;
}

/**
 * 每個受阻原因只吼一次（換原因才會再吼），避免 4s tick 洗版；
 * 未被擋（none）則清空記錄，讓同一原因日後復發時還能再吼一次。
 */
export function decideStuckWarning(
  status: KeyxStatus,
  lastWarnedReason: KeyxBlockReason | null,
  timeoutMs: number
): StuckWarningDecision {
  if (status.reason === 'none') return { warn: false, nextWarnedReason: null };
  if (status.blockedForMs < timeoutMs) return { warn: false, nextWarnedReason: lastWarnedReason };
  if (lastWarnedReason === status.reason) return { warn: false, nextWarnedReason: lastWarnedReason };
  return { warn: true, nextWarnedReason: status.reason };
}

/** 判定 + 記錄；回傳新的「已吼過的原因」供呼叫端存回。 */
export function warnIfKeyxStuck(
  roomId: string,
  status: KeyxStatus,
  lastWarnedReason: KeyxBlockReason | null,
  timeoutMs: number
): KeyxBlockReason | null {
  const d = decideStuckWarning(status, lastWarnedReason, timeoutMs);
  if (d.warn) {
    logger.warn('[MeshGossipManager] keyx 分發持續受阻，房間將退為明文確認', {
      roomId,
      reason: status.reason,
      pendingMembers: status.pendingMembers,
      blockedForMs: status.blockedForMs,
    });
  }
  return d.nextWarnedReason;
}
