import React, { createContext, useContext, useEffect, useState } from 'react';
import {
  signInWithEmailAndPassword,
  signInWithPopup,
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
const SESSION_TIMEOUT_MS = 8 * 60 * 1000;

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
    resetTimer();

    return () => {
      if (timeoutId) clearTimeout(timeoutId);
      events.forEach((evt) => window.removeEventListener(evt, resetTimer));
    };
  }, []);

  // ── Auth 狀態監聽 ──────────────────────────────────────────────
  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, async (firebaseUser: FirebaseUser | null) => {
      logger.debug('[Auth] onAuthStateChanged', {
        hasUser: !!firebaseUser,
        uid: firebaseUser?.uid,
      });
      if (firebaseUser) {
        await loadUserData(firebaseUser);
      } else {
        // 未登入 → 設為 guest（不再自動匿名登入）
        setUser({
          uid: 'guest',
          email: null,
          displayName: null,
          role: 'guest',
        });
        setLoading(false);
      }
    });

    return unsubscribe;
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const loadUserData = async (firebaseUser: FirebaseUser): Promise<void> => {
    try {
      const tokenResult = await firebaseUser.getIdTokenResult();
      const role = (tokenResult.claims.role as UserRole) || 'user';

      logger.debug('[Auth] loadUserData', {
        uid: firebaseUser.uid,
        role,
      });

      // 取得使用者 profile（可選，失敗不影響登入）
      let userData: Record<string, unknown> | null = null;
      try {
        const userSnap = await get(ref(rtdb, 'users/' + firebaseUser.uid));
        userData = userSnap.val();
      } catch {
        // RTDB profile 讀取失敗不影響登入
      }

      setUser({
        uid: firebaseUser.uid,
        email: firebaseUser.email,
        displayName: firebaseUser.displayName || (userData?.displayName as string) || null,
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

    // 一律使用 signInWithPopup（最穩定，避免 redirect 的各種 session 衝突）
    const userCredential = await signInWithPopup(auth, provider);
    await loadUserData(userCredential.user);
  };

  const logout = async (): Promise<void> => {
    try {
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
