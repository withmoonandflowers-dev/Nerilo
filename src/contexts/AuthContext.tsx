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

// 調整這個旗標可以快速開關認證相關的 debug log（目前強制開啟，方便在正式環境排錯）
const DEBUG_AUTH = true;

interface AuthContextType {
  user: User | null;
  loading: boolean;
  loginWithEmail: (email: string, password: string) => Promise<void>;
  loginWithGoogle: () => Promise<void>;
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

export const AuthProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, async (firebaseUser: FirebaseUser | null) => {
      if (DEBUG_AUTH) {
        console.log('[Auth] onAuthStateChanged', {
          hasUser: !!firebaseUser,
          uid: firebaseUser?.uid,
        });
      }
      if (firebaseUser) {
        await loadUserData(firebaseUser);
      } else {
        // 如果沒有使用者，自動使用匿名登入
        try {
          const anonymousUser = await signInAnonymously(auth);
          await loadUserData(anonymousUser.user);
        } catch (error) {
          console.error('Anonymous login error:', error);
          setUser(null);
          setLoading(false);
        }
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

      if (DEBUG_AUTH) {
        console.log('[Auth] loadUserData', {
          uid: firebaseUser.uid,
          isAnonymous: firebaseUser.isAnonymous,
          role,
          claims: tokenResult.claims,
        });
      }

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
    } catch (error: any) {
      console.error('Google login error:', error);

      // 若被瀏覽器擋掉 popup，改用 redirect 流程
      if (error?.code === 'auth/popup-blocked') {
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



