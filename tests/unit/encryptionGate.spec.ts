import { describe, it, expect } from 'vitest';
import {
  sendDecisionFor,
  isEncryptedState,
  visibleEncryptionState,
} from '../../src/core/messaging/encryptionGate';

describe('encryptionGate（ADR-0026 R2 明文降級 fail-visible）', () => {
  it('只有真明文房需要確認；encrypted/exchanging 直接放行', () => {
    expect(sendDecisionFor('plaintext')).toBe('confirm-plaintext');
    expect(sendDecisionFor('encrypted')).toBe('allow');
    expect(sendDecisionFor('exchanging')).toBe('allow');
  });

  it('指示器只在 encrypted 才顯示「已加密」正面樣態（不謊報鎖頭）', () => {
    expect(isEncryptedState('encrypted')).toBe(true);
    expect(isEncryptedState('exchanging')).toBe(false);
    expect(isEncryptedState('plaintext')).toBe(false);
  });

  it('本機有鑰但傳輸未連線時仍顯示交換中，連線後才顯示已加密', () => {
    expect(visibleEncryptionState('encrypted', false)).toBe('exchanging');
    expect(visibleEncryptionState('encrypted', true)).toBe('encrypted');
    expect(visibleEncryptionState('exchanging', true)).toBe('exchanging');
    expect(visibleEncryptionState('plaintext', false)).toBe('plaintext');
  });
});
