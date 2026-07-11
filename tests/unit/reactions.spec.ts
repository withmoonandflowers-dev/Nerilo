/**
 * 訊息 reactions 聚合 reducer 測試——加/移除、去重、冪等（亂序到達收斂）。
 *
 * @vitest-environment node
 */
import { describe, it, expect } from 'vitest';
import { applyReaction, hasReacted, type ReactionMap } from '../../src/features/chat/reactions';

const ev = (messageId: string, emoji: string, from: string, op: 'add' | 'remove' = 'add') => ({ messageId, emoji, from, op });

describe('reactions reducer', () => {
  it('add 累積反應者、去重排序', () => {
    let m: ReactionMap = {};
    m = applyReaction(m, ev('msg1', '👍', 'bob'));
    m = applyReaction(m, ev('msg1', '👍', 'alice'));
    expect(m.msg1!['👍']).toEqual(['alice', 'bob']); // 排序
  });

  it('同人同表情重複 add → no-op（冪等，亂序重送安全）', () => {
    let m: ReactionMap = {};
    m = applyReaction(m, ev('msg1', '👍', 'bob'));
    const after = applyReaction(m, ev('msg1', '👍', 'bob'));
    expect(after).toBe(m); // 未變（回傳同參考）
    expect(m.msg1!['👍']).toEqual(['bob']);
  });

  it('remove 移除該人；最後一人移除後清掉該表情', () => {
    let m: ReactionMap = {};
    m = applyReaction(m, ev('msg1', '👍', 'bob'));
    m = applyReaction(m, ev('msg1', '👍', 'alice'));
    m = applyReaction(m, ev('msg1', '👍', 'bob', 'remove'));
    expect(m.msg1!['👍']).toEqual(['alice']);
    m = applyReaction(m, ev('msg1', '👍', 'alice', 'remove'));
    expect(m.msg1).toBeUndefined(); // 空了 → 整則清掉
  });

  it('沒反應過就 remove → no-op', () => {
    const m: ReactionMap = {};
    expect(applyReaction(m, ev('msg1', '👍', 'bob', 'remove'))).toBe(m);
  });

  it('多表情並存', () => {
    let m: ReactionMap = {};
    m = applyReaction(m, ev('msg1', '👍', 'bob'));
    m = applyReaction(m, ev('msg1', '❤️', 'alice'));
    expect(Object.keys(m.msg1!).sort()).toEqual(['❤️', '👍']);
  });

  it('hasReacted 反映 toggle 狀態', () => {
    let m: ReactionMap = {};
    expect(hasReacted(m, 'msg1', '👍', 'me')).toBe(false);
    m = applyReaction(m, ev('msg1', '👍', 'me'));
    expect(hasReacted(m, 'msg1', '👍', 'me')).toBe(true);
  });

  it('畸形事件 → 原樣返回', () => {
    const m: ReactionMap = {};
    expect(applyReaction(m, { messageId: 'x', emoji: 1 as never, from: 'a', op: 'add' })).toBe(m);
  });
});
