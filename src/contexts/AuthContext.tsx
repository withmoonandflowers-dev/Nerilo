import React, { createContext, useContext, useEffect, useRef, useState } from 'react';
import {
  signInWithEmailAndPassword,
  signInWithPopup,
  signInWithRedirect,
  getRedirectResult,
  signInAnonymously,
  signInWithCredential,
  GoogleAuthProvider,
  signOut,
  onAuthStateChanged,
  User as FirebaseUser,
} from 'firebase/auth';
import { ref, get } from 'firebase/database';
import { auth, rtdb } from '../config/firebase';
import type { User, UserRole } from '../types';
import { logger } from '../utils/logger';

interface AuthContextType {
  user: User | null;
  loading: boolean;
  loginWithEmail: (email: string, password: string) => Promise<void>;
  loginWithGoogle: () => Promise<void>;
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

/** Session timeout（毫秒）：8 小時無互動後自動登出 */
const SESSION_TIMEOUT_MS = 8 * 60 * 60 * 1000;

export const AuthProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);

  // ── Session timeout：偵測使用者閒置，超時後自動登出 ──────────────
  useEffect(() => {
    let timeoutId: ReturnType<typeof setTimeout> | null = null;

    const resetTimer = () => {
      if (timeoutId) clearTimeout(timeoutId);
      timeoutId = setTimeout(async () => {
        logger.warn('[Auth] Session timeout — auto logout');
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

  // ── 統一初始化：先處理 redirect 結果，再監聽 auth 狀態 ──────────
  const redirectCheckedRef = useRef(false);
  const loggedOutRef = useRef(false);
  const pendingGoogleLoginRef = useRef(false);

  useEffect(() => {
    let unsubscribe: (() => void) | null = null;

    const init = async () => {
      // Step 1: 檢查是否有 Google redirect 回來的結果
      try {
        const result = await getRedirectResult(auth);
        if (result?.user) {
          logger.info('[Auth] Google redirect login success', { uid: result.user.uid });
          await loadUserData(result.user);
          redirectCheckedRef.current = true;
          return; // redirect 登入成功，不需要繼續匿名登入
        }
      } catch (err: unknown) {
        // 如果有 credential 衝突（匿名 session 與 Google redirect），嘗試用 credential 直接登入
        const firebaseErr = err as { code?: string; customData?: { _tokenResponse?: { oauthIdToken?: string; oauthAccessToken?: string } } };
        if (firebaseErr.code === 'auth/credential-already-in-use' || firebaseErr.code === 'auth/email-already-in-use') {
          try {
            const credential = GoogleAuthProvider.credentialFromError(err as Parameters<typeof GoogleAuthProvider.credentialFromError>[0]);
            if (credential) {
              logger.info('[Auth] Recovering Google credential from redirect error');
              await signOut(auth);
              const result = await signInWithCredential(auth, credential);
              await loadUserData(result.user);
              redirectCheckedRef.current = true;
              return;
            }
          } catch (recoveryErr) {
            logger.error('[Auth] Failed to recover Google credential:', recoveryErr);
          }
        }
        logger.warn('[Auth] getRedirectResult error (可忽略如非 redirect 登入)', err);
      }
      redirectCheckedRef.current = true;

      // Step 2: 設定 auth 狀態監聽（redirect 結果已處理完畢）
      unsubscribe = onAuthStateChanged(auth, async (firebaseUser: FirebaseUser | null) => {
        logger.debug('[Auth] onAuthStateChanged', {
          hasUser: !!firebaseUser,
          uid: firebaseUser?.uid,
        });
        if (firebaseUser) {
          await loadUserData(firebaseUser);
        } else if (!loggedOutRef.current && !pendingGoogleLoginRef.current) {
          // 初次載入且無使用者、且非正在進行 Google 登入 → 自動匿名登入
          try {
            const anonymousUser = await signInAnonymously(auth);
            await loadUserData(anonymousUser.user);
          } catch (error) {
            logger.error('[Auth] Anonymous login error:', error);
            setUser(null);
            setLoading(false);
          }
        } else {
          // 使用者主動登出
          setUser(null);
          setLoading(false);
        }
      });
    };

    init();

    return () => {
      if (unsubscribe) unsubscribe();
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

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
      const userSnap = await get(ref(rtdb, 'users/' + firebaseUser.uid));
      const userData = userSnap.val();

      setUser({
        uid: firebaseUser.uid,
        email: firebaseUser.email,
        displayName: firebaseUser.displayName || userData?.displayName || null,
        role,
        customClaims: tokenResult.claims,
      });
    } catch (error) {
      logger.error('[Auth] Error loading user data:', error);
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
      logger.error('[Auth] Login error:', error);
      throw error;
    }
  };

  const loginWithGoogle = async (): Promise<void> => {
    const provider = new GoogleAuthProvider();

    // 標記正在進行 Google 登入，防止 onAuthStateChanged 觸發匿名登入
    pendingGoogleLoginRef.current = true;

    // 若目前是匿名使用者，先登出以避免 redirect 回來時 credential 衝突
    if (auth.currentUser?.isAnonymous) {
      logger.info('[Auth] Signing out anonymous user before Google login');
      await signOut(auth);
    }

    // 在行動裝置或已知 popup 問題的環境，直接用 redirect
    const isMobile = /iPhone|iPad|iPod|Android/i.test(navigator.userAgent);
    if (isMobile) {
      logger.info('[Auth] Mobile detected, using redirect for Google login');
      await signInWithRedirect(auth, provider);
      return;
    }

    try {
      const userCredential = await signInWithPopup(auth, provider);
      await loadUserData(userCredential.user);
    } catch (error: unknown) {
      const errorCode = (error as { code?: string })?.code;
      logger.error('[Auth] Google popup login failed, trying redirect', { code: errorCode });

      // popup 失敗（被擋、internal-error、跨域問題等）→ 自動改用 redirect
      if (
        errorCode === 'auth/popup-blocked' ||
        errorCode === 'auth/popup-closed-by-user' ||
        errorCode === 'auth/internal-error' ||
        errorCode === 'auth/cancelled-popup-request' ||
        errorCode === 'auth/unauthorized-domain'
      ) {
        try {
          await signInWithRedirect(auth, provider);
          return;
        } catch (redirectError) {
          logger.error('[Auth] Redirect also failed:', redirectError);
          throw redirectError;
        }
      }

      throw error;
    }
  };

  const logout = async (): Promise<void> => {
    try {
      loggedOutRef.current = true;
      await signOut(auth);
      setUser(null);
    } catch (error) {
      logger.error('[Auth] Logout error:', error);
      throw error;
    }
  };

  return (
    <AuthContext.Provider value={{ user, loading, loginWithEmail, loginWithGoogle, logout }}>
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



