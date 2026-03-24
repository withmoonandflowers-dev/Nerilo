import React, { createContext, useContext, useEffect, useState } from 'react';
import {
  signInWithEmailAndPassword,
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

  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, async (firebaseUser: FirebaseUser | null) => {
      logger.debug('[Auth] onAuthStateChanged', {
        hasUser: !!firebaseUser,
        uid: firebaseUser?.uid,
      });
      if (firebaseUser) {
        await loadUserData(firebaseUser);
      } else if (!user) {
        // 只在初次載入（user 尚未設定）時自動匿名登入
        // 使用者主動登出後不會自動重新匿名登入，讓使用者能真正回到未登入狀態
        try {
          const anonymousUser = await signInAnonymously(auth);
          await loadUserData(anonymousUser.user);
        } catch (error) {
          console.error('Anonymous login error:', error);
          setUser(null);
          setLoading(false);
        }
      } else {
        // 使用者主動登出
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
      console.error('Error loading user data:', error);
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
      console.error('Login error:', error);
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
      console.error('Google login error:', error);

      // 若被瀏覽器擋掉 popup，改用 redirect 流程
      if ((error as { code?: string })?.code === 'auth/popup-blocked') {
        await signInWithRedirect(auth, provider);
        // 重新導向回來後，onAuthStateChanged 會自動載入使用者，不需要在這裡再處理
        return;
      }

      throw error;
    }
  };

  const logout = async (): Promise<void> => {
    try {
      await signOut(auth);
      setUser(null);
    } catch (error) {
      console.error('Logout error:', error);
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



