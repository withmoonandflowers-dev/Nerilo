/**
 * 把 Firebase Auth 錯誤碼轉成使用者看得懂的訊息。
 *
 * 註：auth/internal-error 常是後端 INVALID_LOGIN_CREDENTIALS 被 Firebase JS SDK
 * 包起來的結果（已用 REST API 驗證），所以一併歸到「帳密錯誤」。
 * 未知錯誤會保留原始 code 方便診斷（搭配 Sentry 上報）。
 */
const AUTH_ERROR_MESSAGES: Record<string, string> = {
  'auth/invalid-credential': '電子郵件或密碼錯誤，或此帳號尚未註冊',
  'auth/internal-error': '電子郵件或密碼錯誤，或此帳號尚未註冊',
  'auth/wrong-password': '密碼錯誤',
  'auth/user-not-found': '查無此帳號，請確認電子郵件或改用 Google 登入',
  'auth/invalid-email': '電子郵件格式不正確',
  'auth/email-already-in-use': '此電子郵件已註冊，請直接登入',
  'auth/weak-password': '密碼至少需要 6 個字元',
  'auth/too-many-requests': '嘗試次數過多，請稍後再試',
  'auth/popup-blocked': '瀏覽器擋住了登入視窗，請允許彈出視窗後再試',
  'auth/popup-closed-by-user': '登入已取消',
  'auth/unauthorized-domain': '此網域未被授權登入（設定問題）',
  'auth/network-request-failed': '網路連線失敗，請檢查網路後再試',
};

export function friendlyAuthError(err: unknown): string {
  const code = (err as { code?: string })?.code ?? '';
  const friendly = AUTH_ERROR_MESSAGES[code];
  if (friendly) return friendly;
  return `登入失敗${code ? `（${code}）` : ''}`;
}
