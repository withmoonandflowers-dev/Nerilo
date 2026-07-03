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
