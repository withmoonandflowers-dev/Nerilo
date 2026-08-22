/**
 * Lemon Squeezy webhook 純邏輯測試（ADR-0008）。
 *
 * @vitest-environment node
 */
import { describe, it, expect } from 'vitest';
import { createHmac } from 'node:crypto';
import {
  verifySignature,
  resolvePlanChange,
  extractUid,
  extractEvent,
  extractSubscriptionId,
  applySubscriptionChange,
} from '../../netlify/functions/_lib/webhook-core';

const SECRET = 'test-webhook-secret';
const sign = (body: string) => createHmac('sha256', SECRET).update(body).digest('hex');

describe('verifySignature', () => {
  it('accepts a valid HMAC-SHA256 signature', () => {
    const body = JSON.stringify({ meta: { event_name: 'subscription_created' } });
    expect(verifySignature(body, sign(body), SECRET)).toBe(true);
  });

  it('rejects a tampered body', () => {
    const body = '{"a":1}';
    const sig = sign(body);
    expect(verifySignature('{"a":2}', sig, SECRET)).toBe(false);
  });

  it('rejects wrong secret, missing signature, and empty secret', () => {
    const body = '{"a":1}';
    expect(verifySignature(body, createHmac('sha256', 'other').update(body).digest('hex'), SECRET)).toBe(false);
    expect(verifySignature(body, null, SECRET)).toBe(false);
    expect(verifySignature(body, sign(body), '')).toBe(false);
  });

  it('rejects signatures of the wrong length without throwing', () => {
    expect(verifySignature('{}', 'deadbeef', SECRET)).toBe(false);
  });
});

describe('resolvePlanChange', () => {
  it.each([
    ['subscription_created', undefined, 'pro'],
    ['subscription_resumed', undefined, 'pro'],
    ['subscription_unpaused', undefined, 'pro'],
    ['subscription_updated', 'active', 'pro'],
    ['subscription_updated', 'on_trial', 'pro'],
    ['subscription_updated', 'past_due', 'pro'],
    ['subscription_updated', 'expired', 'free'],
    ['subscription_expired', undefined, 'free'],
  ] as const)('%s (%s) → %s', (event, status, expected) => {
    expect(resolvePlanChange(event, status)).toBe(expected);
  });

  it.each([
    ['subscription_updated', 'cancelled'], // 期末才由 expired 收尾，期間保留權益
    ['subscription_updated', undefined],
    ['subscription_cancelled', undefined],
    ['order_created', undefined],
    ['subscription_payment_success', undefined],
  ] as const)('%s (%s) → null（忽略）', (event, status) => {
    expect(resolvePlanChange(event, status)).toBeNull();
  });
});

describe('extractUid / extractEvent', () => {
  it('extracts uid from meta.custom_data', () => {
    expect(extractUid({ meta: { custom_data: { uid: 'firebase-uid-123' } } })).toBe(
      'firebase-uid-123'
    );
  });

  it('returns null for missing, non-string, or absurd uid', () => {
    expect(extractUid({})).toBeNull();
    expect(extractUid({ meta: { custom_data: { uid: 42 } } })).toBeNull();
    expect(extractUid({ meta: { custom_data: { uid: 'x'.repeat(200) } } })).toBeNull();
  });

  it('extracts event name and subscription status', () => {
    expect(
      extractEvent({
        meta: { event_name: 'subscription_updated' },
        data: { attributes: { status: 'active' } },
      })
    ).toEqual({ eventName: 'subscription_updated', status: 'active' });
  });
});

describe('extractSubscriptionId / applySubscriptionChange（M-6）', () => {
  it('取得訂閱 id（字串與數字皆正規化為字串）', () => {
    expect(extractSubscriptionId({ data: { id: 'sub_123' } })).toBe('sub_123');
    expect(extractSubscriptionId({ data: { id: 456 } })).toBe('456');
    expect(extractSubscriptionId({})).toBeNull();
    expect(extractSubscriptionId({ data: { id: 'x'.repeat(200) } })).toBeNull();
  });

  it('pro 事件把訂閱加進集合，方案為 pro', () => {
    expect(applySubscriptionChange([], 'sub_a', 'pro')).toEqual({
      activeSubscriptions: ['sub_a'],
      effectivePlan: 'pro',
    });
  });

  it('同一訂閱重複 pro 事件不重複累加（冪等）', () => {
    expect(applySubscriptionChange(['sub_a'], 'sub_a', 'pro').activeSubscriptions).toEqual(['sub_a']);
  });

  it('最後一筆訂閱到期 → 降為 free', () => {
    expect(applySubscriptionChange(['sub_a'], 'sub_a', 'free')).toEqual({
      activeSubscriptions: [],
      effectivePlan: 'free',
    });
  });

  it('M-6 核心：攻擊者掛在受害者 uid 的訂閱到期，不影響受害者自己的訂閱', () => {
    // 受害者自己的 sub_victim 仍有效，攻擊者的 sub_attacker 到期
    const r = applySubscriptionChange(['sub_victim', 'sub_attacker'], 'sub_attacker', 'free');
    expect(r.activeSubscriptions).toEqual(['sub_victim']);
    expect(r.effectivePlan).toBe('pro'); // 不被降級
  });

  it('移除不存在的訂閱不會誤降級', () => {
    const r = applySubscriptionChange(['sub_victim'], 'sub_unknown', 'free');
    expect(r.effectivePlan).toBe('pro');
  });
});
