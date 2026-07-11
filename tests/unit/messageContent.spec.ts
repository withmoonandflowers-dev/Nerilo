/**
 * 訊息內容編碼測試——回覆嵌入/解出、純文字向下相容、壞資料安全降級。
 *
 * @vitest-environment node
 */
import { describe, it, expect } from 'vitest';
import { encodeContent, decodeContent } from '../../src/features/chat/messageContent';

describe('messageContent', () => {
  it('純文字 encode 原樣返回（向下相容）', () => {
    expect(encodeContent('hello')).toBe('hello');
    expect(encodeContent('hello', undefined)).toBe('hello');
  });

  it('回覆 encode → decode 來回一致', () => {
    const enc = encodeContent('好喔', 'msg-123');
    expect(enc).not.toBe('好喔'); // 帶標記
    expect(decodeContent(enc)).toEqual({ text: '好喔', replyTo: 'msg-123' });
  });

  it('純文字 decode → 無 replyTo', () => {
    expect(decodeContent('just text')).toEqual({ text: 'just text' });
  });

  it('內容含 JSON 但無標記 → 當純文字', () => {
    expect(decodeContent('{"r":"x","t":"y"}')).toEqual({ text: '{"r":"x","t":"y"}' });
  });

  it('壞資料（標記後非合法 JSON / 缺欄位）→ 當純文字', () => {
    expect(decodeContent('nrl-reply{bad').text).toContain('nrl-reply');
    expect(decodeContent('nrl-reply' + JSON.stringify({ r: 1, t: 'x' }))).toEqual({
      text: 'nrl-reply' + JSON.stringify({ r: 1, t: 'x' }),
    });
  });

  it('非字串 → 空字串', () => {
    expect(decodeContent(null)).toEqual({ text: '' });
    expect(decodeContent(42)).toEqual({ text: '' });
  });

  it('回覆內含換行/表情 保真', () => {
    const enc = encodeContent('多行\n訊息 😀', 'm1');
    expect(decodeContent(enc)).toEqual({ text: '多行\n訊息 😀', replyTo: 'm1' });
  });
});
