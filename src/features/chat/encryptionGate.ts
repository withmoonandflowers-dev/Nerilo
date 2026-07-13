/**
 * 加密狀態與送訊閘門（純邏輯；ADR-0026 R2 明文降級 fail-visible）
 *
 * 三態（由引擎 getEncryptionState 判定，見 MeshGossipManager）：
 *  - 'encrypted'  ：房間內容金鑰就緒（sendEpoch != null）→ 密文送出。
 *  - 'exchanging' ：ECDH 可用、keyx 進行中（暫態，通常數秒）→ 允許送出但指示器誠實顯示交換中。
 *  - 'plaintext'  ：ECDH 不可用（keyCoordinator=null）→ 房間**永久**無法加密（真降級）。
 *
 * fail-visible 核心：不在明文房「靜默送出」。真明文房送訊前必須使用者明確確認，預設拒送。
 * 暫態 exchanging 不硬擋（ADR-0026 只針對「明文房間」），但指示器不得謊報已加密。
 */
import type { EncryptionState } from '../../types';
export type { EncryptionState };

export type SendDecision = 'allow' | 'confirm-plaintext';

/** 給定加密狀態，決定送訊行為。只有真明文房需要確認。 */
export function sendDecisionFor(state: EncryptionState): SendDecision {
  return state === 'plaintext' ? 'confirm-plaintext' : 'allow';
}

/** 指示器該不該顯示「已加密」的正面樣態（只有 encrypted 為真；其餘不得謊報鎖頭）。 */
export function isEncryptedState(state: EncryptionState): boolean {
  return state === 'encrypted';
}
