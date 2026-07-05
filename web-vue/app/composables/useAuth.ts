/**
 * 認證 composable — 對應 React 版 AuthContext（src/contexts/AuthContext.tsx）
 * 行為契約：未登入自動匿名登入；Google popup 失敗 fallback redirect。
 */
import { ref, computed } from 'vue'
import {
  signInWithEmailAndPassword,
  createUserWithEmailAndPassword,
  signInWithPopup,
  signInWithRedirect,
  signInAnonymously,
  signOut,
  onAuthStateChanged,
  GoogleAuthProvider,
} from 'firebase/auth'
import { auth } from '@legacy/config/firebase'
import { featureLog } from '@legacy/utils/featureLog'

export interface AuthUser {
  uid: string
  email: string | null
  displayName: string | null
  isAnonymous: boolean
}

const LOGGED_OUT_KEY = 'nerilo-logged-out'

const user = ref<AuthUser | null>(null)
const loading = ref(true)
let started = false

function startAuthListener() {
  if (started) return
  started = true
  onAuthStateChanged(auth, async (fbUser) => {
    if (fbUser) {
      user.value = {
        uid: fbUser.uid,
        email: fbUser.email,
        displayName: fbUser.displayName,
        isAnonymous: fbUser.isAnonymous,
      }
      loading.value = false
      featureLog('auth', 'state_changed', { uid: fbUser.uid, anonymous: fbUser.isAnonymous })
      return
    }
    // 未登入且非明確登出 → 自動匿名登入（對齊 React 版行為）
    if (!localStorage.getItem(LOGGED_OUT_KEY)) {
      try {
        await signInAnonymously(auth)
        return // onAuthStateChanged 會再進來
      } catch (e) {
        console.error('[useAuth] anonymous sign-in failed', e)
      }
    }
    user.value = null
    loading.value = false
  })
}

export function useAuth() {
  startAuthListener()

  const loginWithGoogle = async () => {
    localStorage.removeItem(LOGGED_OUT_KEY)
    const provider = new GoogleAuthProvider()
    try {
      await signInWithPopup(auth, provider)
    } catch {
      await signInWithRedirect(auth, provider)
    }
  }

  const loginWithEmail = async (email: string, password: string) => {
    localStorage.removeItem(LOGGED_OUT_KEY)
    await signInWithEmailAndPassword(auth, email, password)
  }

  const registerWithEmail = async (email: string, password: string) => {
    localStorage.removeItem(LOGGED_OUT_KEY)
    await createUserWithEmailAndPassword(auth, email, password)
  }

  const logout = async () => {
    localStorage.setItem(LOGGED_OUT_KEY, '1')
    await signOut(auth)
  }

  return {
    user: computed(() => user.value),
    loading: computed(() => loading.value),
    loginWithGoogle,
    loginWithEmail,
    registerWithEmail,
    logout,
  }
}
