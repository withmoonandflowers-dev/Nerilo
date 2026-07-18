/**
 * 房間容量分層（Spec 011 Q7：Free 5、Pro 10）。
 *
 * 容量屬「房主」權益：建房時依房主方案寫入 maxParticipants 欄位，
 * join 一律對房間文件上的容量強制（加入者的方案不影響）。
 * 與 firestore.rules 的 roomCapacity / validMaxParticipantsOnCreate 同語義，
 * 兩處必須同值——rules 是最終防線，client 先給清晰錯誤。
 *
 * 獨立成檔的原因：RoomService 受 god-file 行數棘輪管制（fitness.architecture），
 * 新功能進新檔（比照 meshIdentityRegistry 抽出前例）。
 */

export const DEFAULT_MAX_PARTICIPANTS = 5;
export const ABSOLUTE_MAX_PARTICIPANTS = 10;

/** 正規化建房請求的容量：缺省/畸形 → 5；整數夾在 [2, 10]。 */
export function normalizeMaxParticipants(requested?: number): number {
  if (typeof requested !== 'number' || !Number.isInteger(requested)) {
    return DEFAULT_MAX_PARTICIPANTS;
  }
  return Math.min(Math.max(requested, 2), ABSOLUTE_MAX_PARTICIPANTS);
}

/**
 * 房間文件的有效容量：欄位為 2..10 整數才採用，否則（legacy 無欄位/畸形值）＝5。
 * 語義鏡射 firestore.rules 的 roomCapacity（rules 無 math.min/max，用範圍檢查；
 * 畸形值理論上進不來——create 驗證 + update 不可變——此為縱深防禦）。
 */
export function roomCapacity(roomData: { maxParticipants?: unknown }): number {
  const raw = roomData?.maxParticipants;
  if (
    typeof raw === 'number' &&
    Number.isInteger(raw) &&
    raw >= 2 &&
    raw <= ABSOLUTE_MAX_PARTICIPANTS
  ) {
    return raw;
  }
  return DEFAULT_MAX_PARTICIPANTS;
}

/**
 * 目前登入者（房主視角）可建的房間容量：Pro → 10、Free/匿名/讀取失敗 → undefined
 * （交給 normalizeMaxParticipants 走缺省 5）。rules 依 token.plan 驗證是最終防線。
 */
export async function ownerMaxParticipants(auth: {
  currentUser: { getIdTokenResult(): Promise<{ claims: Record<string, unknown> }> } | null;
}): Promise<number | undefined> {
  try {
    const claims = (await auth.currentUser?.getIdTokenResult())?.claims;
    return claims?.plan === 'pro' ? ABSOLUTE_MAX_PARTICIPANTS : undefined;
  } catch {
    return undefined;
  }
}
