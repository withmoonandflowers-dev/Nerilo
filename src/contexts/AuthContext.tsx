import React, { createContext, useContext, useEffect, useRef, useState } from 'react';
import {
  signInWithEmailAndPassword,
  createUserWithEmailAndPassword,
  signInWithPopup,
  signInWithRedirect,
  signInAnonymously,
  GoogleAuthProvider,
  signOut,
  onAuthStateChanged,
  User as FirebaseUser,
} from 'firebase/auth';
import { doc, getDoc } from 'firebase/firestore';
import { auth, db } from '../config/firebase';
import type { User, UserRole } from '../types';
import { logger } from '../utils/logger';
import { captureError } from '../config/sentry';

/**
 * 從 Firebase Auth 錯誤抽出可診斷的完整細節（code + 後端原始回應）。
 * Firebase 常把後端的 INVALID_LOGIN_CREDENTIALS 等具體錯誤包成籠統的
 * auth/internal-error，真正原因藏在 customData.serverResponse 裡。
 */
function authErrorDetail(error: unknown): Record<string, unknown> {
  const e = error as { code?: string; message?: string; customData?: Record<string, unknown> };
  const server = e?.customData?.serverResponse ?? e?.customData?._serverResponse;
  return {
    code: e?.code ?? 'unknown',
    message: e?.message ?? String(error),
    serverResponse: server,
  };
}

/**
 * 統一的登入錯誤紀錄：寫入 logger（含完整細節）+ 上報 Sentry（production 可驗證）。
 * 這讓每一次登入失敗都產生精確、可追溯的紀錄，而不是只有畫面上籠統的 internal-error。
 */
function logAuthFailure(method: string, error: unknown): void {
  const detail = authErrorDetail(error);
  logger.error(`[Auth] ${method} failed`, detail);
  captureError(error, { authMethod: method, ...detail });
}

interface AuthContextType {
  user: User | null;
  loading: boolean;
  loginWithEmail: (email: string, password: string) => Promise<void>;
  registerWithEmail: (email: string, password: string) => Promise<void>;
  loginWithGoogle: () => Promise<void>;
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

/** Session timeout（毫秒）：8 小時無互動後自動登出 */
const SESSION_TIMEOUT_MS = 8 * 60 * 60 * 1000;

export const AuthProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  /**
   * 明確登出旗標（用 ref，不受 onAuthStateChanged 閉包過期影響）。
   * onAuthStateChanged 的 effect 是 [] deps，閉包裡的 `user` 永遠是初始 null，
   * 若用 `!user` 判斷會導致「登出後立刻又自動匿名登入」（登不出去）。
   * 改用此旗標：true=使用者主動登出 → 不再自動匿名；false=初次載入 → 自動匿名。
   */
  const explicitLogoutRef = useRef(false);

  // ── Session timeout：偵測使用者閒置，超時後自動登出 ──────────────
  useEffect(() => {
    let timeoutId: ReturnType<typeof setTimeout> | null = null;

    const resetTimer = () => {
      if (timeoutId) clearTimeout(timeoutId);
      timeoutId = setTimeout(async () => {
        logger.warn('[Auth] Session timeout — auto logout');
        explicitLogoutRef.current = true; // 閒置登出也算主動登出，不要自動重新匿名
        try { await signOut(auth); } catch { /* ignore */ }
      }, SESSION_TIMEOUT_MS);
    };

    const events = ['mousedown', 'keydown', 'touchstart', 'scroll'] as const;
    events.forEach((evt) => window.addEventListener(evt, resetTimer, { passive: true }));
    resetTimer(); // 初始啟動計時

    return () => {
      if (timeoutId) clearTimeout(timeoutId);
      events.forEach((evt) => window.removeEventListener(evt, resetTimer));
    };
  }, []);

  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, async (firebaseUser: FirebaseUser | null) => {
      logger.debug('[Auth] onAuthStateChanged', {
        hasUser: !!firebaseUser,
        uid: firebaseUser?.uid,
      });
      if (firebaseUser) {
        // 任何真正的登入（含登出後重新 email/Google 登入）都清掉登出旗標
        explicitLogoutRef.current = false;
        await loadUserData(firebaseUser);
      } else if (!explicitLogoutRef.current) {
        // 初次載入（非主動登出）→ 自動匿名登入，讓訪客能直接瀏覽
        try {
          const anonymousUser = await signInAnonymously(auth);
          await loadUserData(anonymousUser.user);
        } catch (error) {
          logger.error('[Auth] Anonymous login error', error);
          setUser(null);
          setLoading(false);
        }
      } else {
        // 使用者主動登出 → 真正回到未登入狀態，不自動重新匿名
        setUser(null);
        setLoading(false);
      }
    });

    return unsubscribe;
  }, []);

  const loadUserData = async (firebaseUser: FirebaseUser): Promise<void> => {
    try {
      // 取得 custom claims（角色資訊）
      const tokenResult = await firebaseUser.getIdTokenResult();
      // 如果是匿名使用者，角色為 guest；否則使用 custom claims 或預設為 user
      const role = firebaseUser.isAnonymous 
        ? 'guest' 
        : ((tokenResult.claims.role as UserRole) || 'user');

      logger.debug('[Auth] loadUserData', {
        uid: firebaseUser.uid,
        isAnonymous: firebaseUser.isAnonymous,
        role,
        // claims 在正式環境會被自動遮罩
        claims: tokenResult.claims,
      });

      // 取得使用者 profile（可選）
      const userDoc = await getDoc(doc(db, 'users', firebaseUser.uid));
      const userData = userDoc.data();

      setUser({
        uid: firebaseUser.uid,
        email: firebaseUser.email,
        displayName: firebaseUser.displayName || userData?.displayName || null,
        role,
        customClaims: tokenResult.claims,
      });
    } catch (error) {
      logger.error('[Auth] Error loading user data', error);
      setUser({
        uid: firebaseUser.uid,
        email: firebaseUser.email,
        displayName: firebaseUser.displayName,
        role: 'user',
      });
    } finally {
      setLoading(false);
    }
  };

  const loginWithEmail = async (email: string, password: string): Promise<void> => {
    try {
      const userCredential = await signInWithEmailAndPassword(auth, email, password);
      await loadUserData(userCredential.user);
    } catch (error) {
      logAuthFailure('email', error);
      throw error;
    }
  };

  const registerWithEmail = async (email: string, password: string): Promise<void> => {
    try {
      const userCredential = await createUserWithEmailAndPassword(auth, email, password);
      await loadUserData(userCredential.user);
    } catch (error) {
      logAuthFailure('email-register', error);
      throw error;
    }
  };

  const loginWithGoogle = async (): Promise<void> => {
    const provider = new GoogleAuthProvider();
    try {
      // 優先嘗試使用 popup
      const userCredential = await signInWithPopup(auth, provider);
      await loadUserData(userCredential.user);
    } catch (error: unknown) {
      const code = (error as { code?: string })?.code;

      // 若被瀏覽器擋掉 popup，改用 redirect 流程（這是正常 fallback，不算失敗）
      if (code === 'auth/popup-blocked' || code === 'auth/cancelled-popup-request') {
        logger.info('[Auth] Google popup blocked, falling back to redirect');
        await signInWithRedirect(auth, provider);
        return;
      }

      // 使用者自己關掉 popup，不上報（非系統錯誤）
      if (code === 'auth/popup-closed-by-user') {
        logger.info('[Auth] Google popup closed by user');
        throw error;
      }

      logAuthFailure('google', error);
      throw error;
    }
  };

  const logout = async (): Promise<void> => {
    try {
      explicitLogoutRef.current = true; // 防止 onAuthStateChanged 又自動匿名登入
      await signOut(auth);
      setUser(null);
    } catch (error) {
      logger.error('[Auth] Logout error', error);
      throw error;
    }
  };

  return (
    <AuthContext.Provider value={{ user, loading, loginWithEmail, registerWithEmail, loginWithGoogle, logout }}>
      {children}
    </AuthContext.Provider>
  );
};

export const useAuth = (): AuthContextType => {
  const context = useContext(AuthContext);
  if (context === undefined) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
};



