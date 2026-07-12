import { describe, it, expect, vi } from 'vitest';
import { NeriloClient } from '../../src/sdk/NeriloClient';
import type { IChatEngine } from '../../src/sdk/IChatEngine';
import type { ChatMessage } from '../../src/types';
import type { ReactionEvent } from '../../src/features/chat/reactions';
import type { ReadEvent } from '../../src/features/chat/readReceipts';
import { orderKeyOf } from '../../src/features/chat/readReceipts';

/** 無 Firebase 的假引擎:證明 NeriloClient 只靠 IChatEngine 契約即可運作、可測。 */
class FakeEngine implements IChatEngine {
  meshUserId: string | null = 'me';
  sent: Array<{ content: string }> = [];
  reads: string[] = [];
  reactionsSent: Array<{ messageId: string; emoji: string; op: string }> = [];
  private msgCbs = new Set<(m: ChatMessage) => void>();
  private reactionCbs = new Set<(e: ReactionEvent) => void>();
  private readCbs = new Set<(e: ReadEvent) => void>();
  initialize = vi.fn(async () => {});
  cleanup = vi.fn(async () => {});
  getMeshUserId() { return this.meshUserId; }
  async sendMessage(content: string) { this.sent.push({ content }); return `id-${this.sent.length}`; }
  onMessage(cb: (m: ChatMessage) => void) { this.msgCbs.add(cb); return () => this.msgCbs.delete(cb); }
  async loadHistory() { return []; }
  async sendReaction(messageId: string, emoji: string, op: string) { this.reactionsSent.push({ messageId, emoji, op }); }
  onReaction(cb: (e: ReactionEvent) => void) { this.reactionCbs.add(cb); return () => this.reactionCbs.delete(cb); }
  async sendRead(watermark: string) { this.reads.push(watermark); }
  onRead(cb: (e: ReadEvent) => void) { this.readCbs.add(cb); return () => this.readCbs.delete(cb); }
  async sendTyping() {}
  onTyping() { return () => {}; }
  // 測試用:模擬遠端事件
  emitRead(ev: ReadEvent) { this.readCbs.forEach((c) => c(ev)); }
  emitReaction(ev: ReactionEvent) { this.reactionCbs.forEach((c) => c(ev)); }
}

const msg = (from: string, timestamp: number): ChatMessage => ({
  messageId: `${from}-${timestamp}`, from, content: 'hi', timestamp,
});

describe('NeriloClient', () => {
  it('connect 呼叫 engine.initialize', async () => {
    const e = new FakeEngine();
    const c = new NeriloClient(e);
    await c.connect();
    expect(e.initialize).toHaveBeenCalledOnce();
  });

  it('sendMessage 委派給 engine(回覆帶編碼標記)', async () => {
    const e = new FakeEngine();
    const c = new NeriloClient(e);
    await c.connect();
    await c.sendMessage('hello');
    expect(e.sent[0].content).toBe('hello'); // 純文字不編碼
    await c.sendMessage('re', 'orig-1');
    expect(e.sent[1].content).toContain('orig-1'); // 回覆嵌入被回覆 id
  });

  it('react toggle:先 add 後 remove,樂觀反映在 reactionsFor', async () => {
    const e = new FakeEngine();
    const c = new NeriloClient(e);
    await c.connect();
    await c.react('m1', '👍');
    expect(c.reactionsFor('m1')).toEqual([{ emoji: '👍', count: 1, mine: true }]);
    expect(e.reactionsSent[0].op).toBe('add');
    await c.react('m1', '👍');
    expect(c.reactionsFor('m1')).toEqual([]);
    expect(e.reactionsSent[1].op).toBe('remove');
  });

  it('markReadUpTo 只在水位前進時廣播一次', async () => {
    const e = new FakeEngine();
    const c = new NeriloClient(e);
    await c.connect();
    c.markReadUpTo([msg('me', 100), msg('bob', 200)]);
    c.markReadUpTo([msg('bob', 150)]); // 較低 → 不再送
    expect(e.reads).toEqual([orderKeyOf({ timestamp: 200 })]);
  });

  it('readCountFor 數遠端已讀者,排除作者與我', async () => {
    const e = new FakeEngine();
    const c = new NeriloClient(e);
    await c.connect();
    const mine = msg('me', 100);
    expect(c.readCountFor(mine)).toBe(0);
    // 遠端 bob 回報已讀到 >= 該訊息
    e.emitRead({ from: 'bob', watermark: orderKeyOf({ timestamp: 200 }) });
    expect(c.readCountFor(mine)).toBe(1);
    // 我自己的樂觀水位不計入
    c.markReadUpTo([mine]);
    expect(c.readCountFor(mine)).toBe(1);
  });

  it('dispose 退訂並呼叫 engine.cleanup', async () => {
    const e = new FakeEngine();
    const c = new NeriloClient(e);
    await c.connect();
    await c.dispose();
    expect(e.cleanup).toHaveBeenCalledOnce();
    // dispose 後遠端事件不再改變聚合(已退訂)
    e.emitReaction({ messageId: 'm1', emoji: '👍', from: 'bob', op: 'add' });
    expect(c.reactionsFor('m1')).toEqual([]);
  });
});
