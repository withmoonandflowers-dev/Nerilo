/**
 * InviteRendezvous 測試（Spec 005 T4）—— 邀請連結會合資訊 + warm 耐心。
 * @vitest-environment node
 */
import { describe, it, expect } from 'vitest';
import {
  buildInviteUrl,
  encodeInviteRendezvous,
  parseInviteRendezvous,
  introducerStoreKey,
} from '../../src/core/p2p/InviteRendezvous';
import { WarmColdSignalingTransport } from '../../src/core/p2p/WarmColdSignalingTransport';
import type { SignalingTransport } from '../../src/core/p2p/SignalingTransport.types';

const inviter = { uid: 'uid-B', pubKey: 'PUB'.repeat(20), ecdhPubKey: 'ECD'.repeat(20) };

describe('InviteRendezvous — 編解碼', () => {
  it('build → parse 往返一致（fragment 形式）', () => {
    const url = buildInviteUrl('https://nerilo.web.app', { room: 'room-1', inviter });
    expect(url).toMatch(/^https:\/\/nerilo\.web\.app\/waiting\/room-1#nrz=/);
    const rz = parseInviteRendezvous(url);
    expect(rz).toEqual({ v: 'nrz1', room: 'room-1', inviter });
  });

  it('會合資訊在 fragment（#）不在 path/query（不上送伺服器）', () => {
    const url = buildInviteUrl('https://x.y', { room: 'r', inviter });
    const beforeHash = url.split('#')[0]!;
    expect(beforeHash).not.toContain('nrz');
    expect(beforeHash).not.toContain(inviter.uid);
  });

  it('中文/特殊字元 room id 也能往返', () => {
    const rz = parseInviteRendezvous(
      `#nrz=${encodeInviteRendezvous({ room: '房間-測試/x', inviter: { uid: 'u1' } })}`
    );
    expect(rz?.room).toBe('房間-測試/x');
  });

  it('僅 uid（無公鑰）合法；可選欄位型別錯 → null', () => {
    expect(parseInviteRendezvous(`#nrz=${encodeInviteRendezvous({ room: 'r', inviter: { uid: 'u' } })}`))
      .toEqual({ v: 'nrz1', room: 'r', inviter: { uid: 'u' } });
    const bad = btoa(JSON.stringify({ v: 'nrz1', room: 'r', inviter: { uid: 'u', pubKey: 42 } }));
    expect(parseInviteRendezvous(`#nrz=${bad}`)).toBeNull();
  });

  it('不可信輸入不拋錯：壞編碼/壞 JSON/缺欄位/版本不符 → null', () => {
    for (const s of ['', '#', '#nrz=', '#nrz=!!!', '#nrz=e30', '#other=x',
      `#nrz=${btoa(JSON.stringify({ v: 'nrz9', room: 'r', inviter: { uid: 'u' } }))}`,
      `#nrz=${btoa(JSON.stringify({ v: 'nrz1', inviter: { uid: 'u' } }))}`,
      `#nrz=${btoa(JSON.stringify({ v: 'nrz1', room: 'r' }))}`]) {
      expect(parseInviteRendezvous(s)).toBeNull();
    }
  });

  it('introducerStoreKey 依房間區隔', () => {
    expect(introducerStoreKey('r1')).not.toBe(introducerStoreKey('r2'));
  });
});

// ── warm 耐心（T4：介紹加入時 NACK 先重試再退 cold）────────────────────────────
function transportWithScript(script: Array<'ok' | 'fail'>, log: string[]): SignalingTransport {
  let i = 0;
  return {
    subscribe: () => () => {},
    send: async () => {
      const r = script[Math.min(i++, script.length - 1)];
      log.push(`warm:${r}`);
      if (r === 'fail') throw new Error('NACK');
    },
    cleanupOlderThan: async () => {},
    cleanupOwn: async () => {},
  };
}

describe('WarmColdSignalingTransport — 介紹加入耐心', () => {
  it('耐心窗內 warm 由敗轉成 → 成功走 warm，cold 零寫入', async () => {
    const log: string[] = [];
    const t = new WarmColdSignalingTransport(
      transportWithScript(['fail', 'fail', 'ok'], log),
      () => ({ ...transportWithScript(['ok'], log), send: async () => { log.push('cold:send'); } }),
      () => true,
      'test',
      { applies: () => true, totalMs: 2_000, retryDelayMs: 20 }
    );
    await t.send({ type: 'offer' });
    expect(log).toEqual(['warm:fail', 'warm:fail', 'warm:ok']);
  });

  it('耐心窗盡仍敗 → 退 cold 並黏住', async () => {
    const log: string[] = [];
    const t = new WarmColdSignalingTransport(
      transportWithScript(['fail'], log),
      () => ({ ...transportWithScript(['ok'], log), send: async (d) => { log.push(`cold:${d.type as string}`); } }),
      () => true,
      'test',
      { applies: () => true, totalMs: 60, retryDelayMs: 20 }
    );
    await t.send({ type: 'offer' });
    await t.send({ type: 'ice' });
    expect(log.at(-2)).toBe('cold:offer');
    expect(log.at(-1)).toBe('cold:ice'); // 黏住：第二則不再試 warm
  });

  it('不適用耐心（非介紹加入）→ 一敗即退 cold', async () => {
    const log: string[] = [];
    const t = new WarmColdSignalingTransport(
      transportWithScript(['fail', 'ok'], log),
      () => ({ ...transportWithScript(['ok'], log), send: async () => { log.push('cold:send'); } }),
      () => true,
      'test',
      { applies: () => false, totalMs: 2_000, retryDelayMs: 20 }
    );
    await t.send({ type: 'offer' });
    expect(log).toEqual(['warm:fail', 'cold:send']);
  });
});
