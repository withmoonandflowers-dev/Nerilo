import { describe, it, expect } from 'vitest';
import {
  applyRead,
  readCount,
  readersOf,
  orderKeyOf,
  type ReadState,
} from '../../src/features/chat/readReceipts';

describe('readReceipts.orderKeyOf', () => {
  it('數值序 == 字典序（wallTime 零填，避免 "9" > "10"）', () => {
    const k9 = orderKeyOf({ timestamp: 9 });
    const k10 = orderKeyOf({ timestamp: 10 });
    expect(k9 < k10).toBe(true);
  });

  it('hlc 優先於 timestamp；同 wallTime 以 logical 分高下', () => {
    const a = orderKeyOf({ timestamp: 0, hlc: { wallTime: 100, logical: 1, nodeId: 'x' } });
    const b = orderKeyOf({ timestamp: 0, hlc: { wallTime: 100, logical: 2, nodeId: 'x' } });
    expect(a < b).toBe(true);
  });

  it('無 hlc 退回 timestamp，且與 hlc.wallTime 可互比', () => {
    const plain = orderKeyOf({ timestamp: 100 });
    const hlc = orderKeyOf({ timestamp: 0, hlc: { wallTime: 100, logical: 0, nodeId: 'x' } });
    expect(plain).toBe(hlc);
  });
});

describe('readReceipts.applyRead', () => {
  it('每人取 max，單調不倒退', () => {
    let s: ReadState = {};
    s = applyRead(s, { from: 'bob', watermark: orderKeyOf({ timestamp: 200 }) });
    s = applyRead(s, { from: 'bob', watermark: orderKeyOf({ timestamp: 100 }) }); // 較低 → no-op
    expect(s['bob']).toBe(orderKeyOf({ timestamp: 200 }));
  });

  it('亂序到達仍收斂到最高水位', () => {
    const k1 = orderKeyOf({ timestamp: 100 });
    const k2 = orderKeyOf({ timestamp: 200 });
    const k3 = orderKeyOf({ timestamp: 300 });
    let s: ReadState = {};
    for (const k of [k2, k1, k3, k1, k2]) s = applyRead(s, { from: 'a', watermark: k });
    expect(s['a']).toBe(k3);
  });

  it('冪等：重複同一水位不變（回傳原物件）', () => {
    const k = orderKeyOf({ timestamp: 100 });
    const s1 = applyRead({}, { from: 'a', watermark: k });
    const s2 = applyRead(s1, { from: 'a', watermark: k });
    expect(s2).toBe(s1);
  });

  it('壞事件（缺欄位）忽略', () => {
    const s: ReadState = { a: orderKeyOf({ timestamp: 1 }) };
    // @ts-expect-error 故意壞資料
    expect(applyRead(s, { from: 'a' })).toBe(s);
    // @ts-expect-error 故意壞資料
    expect(applyRead(s, null)).toBe(s);
  });
});

describe('readReceipts.readCount', () => {
  const kMsg = orderKeyOf({ timestamp: 100 });
  const kHigh = orderKeyOf({ timestamp: 200 });
  const kLow = orderKeyOf({ timestamp: 50 });

  it('數水位 ≥ 訊息位置的成員，排除作者', () => {
    const s: ReadState = { author: kHigh, bob: kHigh, carol: kLow };
    // author 讀過自己不算；bob ≥ 算 1；carol < 不算
    expect(readCount(s, kMsg, 'author')).toBe(1);
  });

  it('水位剛好等於訊息位置算已讀（>=）', () => {
    const s: ReadState = { bob: kMsg };
    expect(readCount(s, kMsg, 'author')).toBe(1);
  });

  it('exclude 再排除「我」（顯示自己訊息時不把自己算進去）', () => {
    const s: ReadState = { me: kHigh, bob: kHigh };
    expect(readCount(s, kMsg, 'me', ['me'])).toBe(1); // author=me 已排除，bob=1
  });

  it('空狀態 → 0', () => {
    expect(readCount({}, kMsg, 'author')).toBe(0);
  });
});

describe('readReceipts.readersOf', () => {
  it('回傳已讀成員（去重排序，排除作者）', () => {
    const kMsg = orderKeyOf({ timestamp: 100 });
    const hi = orderKeyOf({ timestamp: 200 });
    const s: ReadState = { carol: hi, bob: hi, author: hi };
    expect(readersOf(s, kMsg, 'author')).toEqual(['bob', 'carol']);
  });
});
