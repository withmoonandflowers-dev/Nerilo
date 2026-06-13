/**
 * 功能運行時日誌：統一前綴 [NERILO:feature:action]，供 E2E 斷言確認該功能路徑有被執行。
 * 規範：每個功能在關鍵路徑必須呼叫 featureLog，以便 E2E 可驗證實際有跑到對應程式。
 *
 * @see docs/模組化與可插拔架構.md § 運行時可驗證日誌
 * @see docs/開發規範.md
 */

const PREFIX = 'NERILO';

export type FeatureId = 'chat' | 'dashboard' | 'waiting' | 'auth' | 'onboarding';

/**
 * 輸出格式：[NERILO:feature:action] optional JSON payload
 * E2E 可透過 page.on('console') 收集後 assert 文字包含 NERILO:feature:action
 */
export function featureLog(
  feature: FeatureId,
  action: string,
  payload?: Record<string, unknown>
): void {
  const tag = `[${PREFIX}:${feature}:${action}]`;
  if (payload !== undefined && Object.keys(payload).length > 0) {
    console.log(tag, payload);
  } else {
    console.log(tag);
  }
}

/** 用於 E2E 斷言的可預期 action 常數，與 featureLog 第二參數一致 */
export const FEATURE_LOG_ACTIONS = {
  chat: ['init', 'room_joined', 'architecture_decided', 'message_sent', 'leave_room'] as const,
  dashboard: ['room_created', 'join_room_clicked', 'room_joined_from_list'] as const,
  waiting: ['room_subscribed', 'room_open_redirect', 'cancel_or_leave', 'activate_room'] as const,
  auth: ['login', 'logout'] as const,
} as const;
