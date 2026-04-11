/**
 * Firebase Auth 錯誤碼 → 使用者友善中文訊息
 */

const errorMessages: Record<string, string> = {
  'auth/invalid-credential': '電子郵件或密碼錯誤',
  'auth/user-not-found': '找不到此帳號',
  'auth/wrong-password': '密碼錯誤',
  'auth/invalid-email': '電子郵件格式不正確',
  'auth/email-already-in-use': '此電子郵件已被使用',
  'auth/too-many-requests': '登入嘗試次數過多，請稍後再試',
  'auth/network-request-failed': '網路連線失敗，請檢查網路',
  'auth/popup-blocked': '彈出視窗被封鎖，請允許彈出視窗後再試',
  'auth/popup-closed-by-user': '登入視窗已關閉，請重試',
  'auth/cancelled-popup-request': '登入已取消',
  'auth/user-disabled': '此帳號已被停用',
  'auth/operation-not-allowed': '此登入方式未啟用',
  'auth/unauthorized-domain': '此網域未授權進行登入',
};

const DEFAULT_MESSAGE = '登入失敗，請稍後再試';

/**
 * 將 Firebase Auth 錯誤轉換為使用者友善的中文訊息
 */
export function getFirebaseErrorMessage(error: unknown): string {
  const code = (error as { code?: string })?.code;
  if (code && code in errorMessages) {
    return errorMessages[code];
  }
  return DEFAULT_MESSAGE;
}
