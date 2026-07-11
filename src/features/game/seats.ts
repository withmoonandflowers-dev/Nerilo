/**
 * 房內遊戲座位純邏輯（3–5 人房：2 人對戰、其餘觀戰）
 *
 * 收斂模型（無 CRDT 複雜度）：座位由「想玩的人集合」的純函數決定，所有節點看到同一集合
 * 即算出同一座位分配。座 0 恆為房主；座 1 為想玩的非房主中「最早 claim」者（tiebreak id）。
 * claim/release 只是往集合加/減成員，經 mesh 'seat' 通道廣播 + 新進者 SYNC → 最終一致。
 */

/** playerId → claim 時刻（毫秒）。房主不在其中（房主恆為座 0）。 */
export type SeatClaims = Record<string, number>;

export type SeatRole = 'first' | 'second' | 'spectator';

/** 座 1 持有者：想玩的非房主中最早 claim（同時則 id 小者）。無則 null。 */
export function seat1Holder(wanting: SeatClaims, ownerId: string): string | null {
  let best: { id: string; ts: number } | null = null;
  for (const [id, ts] of Object.entries(wanting)) {
    if (id === ownerId) continue;
    if (!best || ts < best.ts || (ts === best.ts && id < best.id)) best = { id, ts };
  }
  return best?.id ?? null;
}

/** 某人的角色：房主＝first（座0），座1 持有者＝second，其餘＝spectator。 */
export function seatRole(wanting: SeatClaims, ownerId: string, selfId: string): SeatRole {
  if (selfId === ownerId) return 'first';
  return seat1Holder(wanting, ownerId) === selfId ? 'second' : 'spectator';
}
