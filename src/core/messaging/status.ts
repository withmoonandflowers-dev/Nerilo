/**
 * SDK 狀態透出的純映射（Spec 024）：把引擎既有的內部狀態翻譯成嵌入者語彙。
 *
 * 這裡沒有新狀態機——內部事實只有兩個既存來源：
 *  - 連線：MeshChatService.getConnectionState()（idle/connecting/connected/failed/closed）
 *  - 加密：securityLabel.deriveEncryptionState() 衍生的 EncryptionState（encrypted/exchanging/plaintext）
 * 本模組只做語彙翻譯與相等判定，零 I/O、零框架，單元可直測。
 *
 * 命名註記（實作期修訂，Spec 024 Q1）：spec 草案把加密軸取名 EncryptionState，
 * 與既有內部型別 `EncryptionState` 撞名，故 SDK 軸型別冠 Nerilo 前綴。
 */

import type { EncryptionState } from './encryptionGate';

/** 傳輸軸：嵌入者視角的「現在資料走得通嗎、走哪條」。 */
export type NeriloTransportState = 'connecting' | 'p2p' | 'offline';

/** 加密軸：pending=金鑰交換中；ready=現行代金鑰可用；degraded=明文態（真降級或交換逾時，fail-visible）。 */
export type NeriloEncryptionState = 'pending' | 'ready' | 'degraded';

export interface NeriloStatus {
  transport: NeriloTransportState;
  encryption: NeriloEncryptionState;
}

/** 引擎內部連線五態（MeshChatService.getConnectionState 的回傳語彙）。 */
export type InternalConnectionState = 'idle' | 'connecting' | 'connected' | 'failed' | 'closed';

/**
 * 傳輸軸映射：
 *  - connected → p2p（至少一條 mesh 鄰居 DataChannel open）
 *  - idle / connecting → connecting（尚未成形；idle 含「已初始化但還沒發現鄰居」的過渡）
 *  - failed / closed → offline
 */
export function toTransportState(s: InternalConnectionState): NeriloTransportState {
  if (s === 'connected') return 'p2p';
  if (s === 'failed' || s === 'closed') return 'offline';
  return 'connecting';
}

/**
 * 加密軸映射（語彙翻譯，語義不動）：
 *  - encrypted → ready
 *  - exchanging → pending
 *  - plaintext → degraded（deriveEncryptionState 已把「交換逾時」升級為 plaintext，
 *    此處如實透出為 degraded；金鑰事後到位衍生值自動回 ready，可恢復）
 */
export function toEncryptionState(s: EncryptionState): NeriloEncryptionState {
  if (s === 'encrypted') return 'ready';
  if (s === 'plaintext') return 'degraded';
  return 'pending';
}

export function deriveStatus(
  conn: InternalConnectionState,
  enc: EncryptionState
): NeriloStatus {
  return { transport: toTransportState(conn), encryption: toEncryptionState(enc) };
}

/** 相等判定：onStatus 去抖用（同值不重發，比照已讀水位「只前進才送」慣例）。 */
export function statusEquals(a: NeriloStatus, b: NeriloStatus): boolean {
  return a.transport === b.transport && a.encryption === b.encryption;
}
