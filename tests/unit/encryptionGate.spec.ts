import { describe, it, expect } from 'vitest';
import { sendDecisionFor, isEncryptedState } from '../../src/features/chat/encryptionGate';

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
});
