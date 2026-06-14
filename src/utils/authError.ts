/**
 * 把 Firebase Auth 錯誤碼轉成使用者看得懂的訊息。
 *
 * - 明確的錯誤（密碼太短、已註冊…）給乾淨訊息。
 * - 籠統/未知的錯誤（auth/internal-error、未對應的 code）會「把原始 code 顯示在訊息裡」，
 *   讓使用者光截圖就能診斷，不必開 DevTools。internal-error 常是後端錯誤被 SDK 包起來，
 *   真正原因需要這個 code 才能判斷。
 * - 依 mode 區分登入/註冊語境（註冊失敗不該說「尚未註冊」）。
 */
const CLEAR_MESSAGES: Record<string, string> = {
  'auth/wrong-password': '密碼錯誤',
  'auth/invalid-email': '電子郵件格式不正確',
  'auth/email-already-in-use': '此電子郵件已註冊，請改用登入',
  'auth/weak-password': '密碼至少需要 6 個字元',
  'auth/too-many-requests': '嘗試次數過多，請稍後再試',
  'auth/popup-blocked': '瀏覽器擋住了登入視窗，請允許彈出視窗後再試',
  'auth/popup-closed-by-user': '登入已取消',
  'auth/network-request-failed': '網路連線失敗，請檢查網路後再試',
  'auth/user-not-found': '查無此帳號，請確認電子郵件或改用 Google 登入',
};

export function friendlyAuthError(err: unknown, mode: 'login' | 'register' = 'login'): string {
  const code = (err as { code?: string })?.code ?? '';
  const codeSuffix = code ? `（${code}）` : '';

  if (CLEAR_MESSAGES[code]) return CLEAR_MESSAGES[code];

  // 網域未授權：設定問題，附 code
  if (code === 'auth/unauthorized-domain') return `此網域未被授權登入${codeSuffix}`;

  // 帳密錯誤（登入既有帳號失敗）
  if (code === 'auth/invalid-credential') {
    return `電子郵件或密碼錯誤，或此帳號尚未註冊${codeSuffix}`;
  }

  // 籠統/未知錯誤（含 auth/internal-error）：依語境給訊息 + 顯示 code 供診斷
  const action = mode === 'register' ? '註冊' : '登入';
  return `${action}失敗，請改用 Google 登入或稍後再試${codeSuffix}`;
}
