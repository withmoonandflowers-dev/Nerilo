import { describe, it, expect } from 'vitest';
import { friendlyAuthError } from '../../src/utils/authError';

describe('friendlyAuthError', () => {
  it('maps invalid-credential to a clear message', () => {
    expect(friendlyAuthError({ code: 'auth/invalid-credential' })).toContain('電子郵件或密碼錯誤');
  });

  it('maps internal-error the same as invalid-credential (SDK masks the real cause)', () => {
    expect(friendlyAuthError({ code: 'auth/internal-error' })).toContain('電子郵件或密碼錯誤');
  });

  it('maps popup-blocked to actionable guidance', () => {
    expect(friendlyAuthError({ code: 'auth/popup-blocked' })).toContain('彈出視窗');
  });

  it('maps unauthorized-domain to a config hint', () => {
    expect(friendlyAuthError({ code: 'auth/unauthorized-domain' })).toContain('網域');
  });

  it('preserves the raw code for unknown errors (diagnosable)', () => {
    expect(friendlyAuthError({ code: 'auth/some-new-code' })).toBe('登入失敗（auth/some-new-code）');
  });

  it('handles a non-Firebase error without a code', () => {
    expect(friendlyAuthError(new Error('boom'))).toBe('登入失敗');
  });
});
