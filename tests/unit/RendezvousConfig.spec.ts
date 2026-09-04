/** @vitest-environment node */
import { describe, expect, it } from 'vitest';
import {
  normalizeRendezvousUrl,
  selectRendezvousUrl,
} from '../../web-vue/app/lib/rendezvousConfig';

describe('Spec 030 rendezvous 位址來源', () => {
  it('依邀請資料、使用者輸入、部署設定排序', () => {
    expect(selectRendezvousUrl({
      invite: 'http://invite.test:9973',
      user: 'http://user.test:9973',
      deployment: 'https://deploy.test',
    })).toBe('http://invite.test:9973');
    expect(selectRendezvousUrl({
      user: 'http://user.test:9973',
      deployment: 'https://deploy.test',
    })).toBe('http://user.test:9973');
    expect(selectRendezvousUrl({ deployment: 'https://deploy.test/' }))
      .toBe('https://deploy.test');
  });

  it('三層都缺少或無效時不啟用 HTTP cold', () => {
    expect(selectRendezvousUrl({})).toBeUndefined();
    expect(selectRendezvousUrl({ invite: 'ftp://bad.test', user: 'not a url' }))
      .toBeUndefined();
  });

  it('只接受不含帳密的 http(s)，並移除 query 與 fragment', () => {
    expect(normalizeRendezvousUrl(' http://127.0.0.1:9973/path/?token=x#fragment '))
      .toBe('http://127.0.0.1:9973/path');
    expect(normalizeRendezvousUrl('https://user:secret@example.test')).toBeUndefined();
    expect(normalizeRendezvousUrl('javascript:alert(1)')).toBeUndefined();
  });
});
