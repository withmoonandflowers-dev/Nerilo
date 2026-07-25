/**
 * 訊息表情 reactions 純邏輯（聚合 reducer；與 UI/傳輸解耦，可測）
 *
 * 一則 reaction 事件 = 某人（from）對某訊息（messageId）加/移除某表情（emoji）。
 * 事件走 mesh 'reaction' 通道（與聊天同 E2EE、同可靠管線），到達順序不保證但冪等：
 * add 把 from 併進集合、remove 移除；重複 add/remove 皆 no-op → 亂序到達仍收斂一致。
 *
 * 聚合結果形狀（好給 Vue 反應式渲染）：
 *   { [messageId]: { [emoji]: string[] } }   // string[] = 去重排序的 from 清單
 */

export type ReactionOp = 'add' | 'remove';

export interface ReactionEvent {
  messageId: string;
  emoji: string;
  from: string;
  op: ReactionOp;
}

/** messageId → emoji → 反應者（去重排序）。 */
export type ReactionMap = Record<string, Record<string, string[]>>;

/** 套用一個 reaction 事件，回傳新的聚合（不可變更新，方便 Vue 偵測）。 */
export function applyReaction(map: ReactionMap, ev: ReactionEvent): ReactionMap {
  if (!ev || typeof ev.messageId !== 'string' || typeof ev.emoji !== 'string' || typeof ev.from !== 'string') {
    return map;
  }
  const byEmoji = { ...(map[ev.messageId] ?? {}) };
  const current = byEmoji[ev.emoji] ?? [];
  let next: string[];
  if (ev.op === 'add') {
    if (current.includes(ev.from)) return map; // 已有 → no-op（冪等）
    next = [...current, ev.from].sort();
  } else {
    if (!current.includes(ev.from)) return map; // 沒有 → no-op
    next = current.filter((f) => f !== ev.from);
  }
  if (next.length > 0) byEmoji[ev.emoji] = next;
  else delete byEmoji[ev.emoji];

  const out = { ...map };
  if (Object.keys(byEmoji).length > 0) out[ev.messageId] = byEmoji;
  else delete out[ev.messageId];
  return out;
}

/** 我對某訊息某表情是否已反應（供 UI toggle）。 */
export function hasReacted(map: ReactionMap, messageId: string, emoji: string, me: string): boolean {
  return (map[messageId]?.[emoji] ?? []).includes(me);
}
