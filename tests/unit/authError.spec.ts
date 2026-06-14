import { describe, it, expect } from 'vitest';
import { friendlyAuthError } from '../../src/utils/authError';

describe('friendlyAuthError', () => {
  it('maps invalid-credential to a clear message and shows the code', () => {
    const msg = friendlyAuthError({ code: 'auth/invalid-credential' });
    expect(msg).toContain('電子郵件或密碼錯誤');
    expect(msg).toContain('auth/invalid-credential');
  });

  it('internal-error in login mode → 登入失敗 + code (diagnosable)', () => {
    const msg = friendlyAuthError({ code: 'auth/internal-error' }, 'login');
    expect(msg).toContain('登入失敗');
    expect(msg).toContain('auth/internal-error');
  });

  it('internal-error in register mode → 註冊失敗 (not the misleading "尚未註冊")', () => {
    const msg = friendlyAuthError({ code: 'auth/internal-error' }, 'register');
    expect(msg).toContain('註冊失敗');
    expect(msg).toContain('auth/internal-error');
    expect(msg).not.toContain('尚未註冊');
  });

  it('weak-password gives a clean message (no code noise)', () => {
    expect(friendlyAuthError({ code: 'auth/weak-password' })).toBe('密碼至少需要 6 個字元');
  });

  it('email-already-in-use guides to login', () => {
    expect(friendlyAuthError({ code: 'auth/email-already-in-use' })).toContain('改用登入');
  });

  it('maps popup-blocked to actionable guidance', () => {
    expect(friendlyAuthError({ code: 'auth/popup-blocked' })).toContain('彈出視窗');
  });

  it('unknown code is shown verbatim for diagnosis', () => {
    expect(friendlyAuthError({ code: 'auth/some-new-code' }, 'register')).toContain('auth/some-new-code');
  });

  it('handles a non-Firebase error without a code', () => {
    const msg = friendlyAuthError(new Error('boom'));
    expect(msg).toContain('登入失敗');
  });
});
