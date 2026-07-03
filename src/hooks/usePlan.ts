/**
 * 訂閱方案 entitlement（ADR-0008）。
 *
 * 真相源是 ID token 的 custom claim `plan`（由 LS webhook 經 firebase-admin
 * 寫入）；前端只讀不判權，配額強制在 firestore.rules。
 *
 * claim 更新後 ID token 最長 1 小時才自然輪替，refresh() 強制刷新——
 * 結帳返回頁應呼叫它讓 Pro 即時生效。
 */
import { useState, useEffect, useCallback } from 'react';
import { onIdTokenChanged, type User as FirebaseUser } from 'firebase/auth';
import { auth } from '../config/firebase';

export type Plan = 'free' | 'pro';

async function readPlan(firebaseUser: FirebaseUser | null): Promise<Plan> {
  if (!firebaseUser || firebaseUser.isAnonymous) return 'free';
  const token = await firebaseUser.getIdTokenResult();
  return token.claims.plan === 'pro' ? 'pro' : 'free';
}

export function usePlan(): { plan: Plan; loading: boolean; refresh: () => Promise<Plan> } {
  const [plan, setPlan] = useState<Plan>('free');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const unsubscribe = onIdTokenChanged(auth, async (firebaseUser) => {
      setPlan(await readPlan(firebaseUser));
      setLoading(false);
    });
    return unsubscribe;
  }, []);

  const refresh = useCallback(async (): Promise<Plan> => {
    const current = auth.currentUser;
    if (current) {
      await current.getIdToken(true); // 強制刷新 → 觸發 onIdTokenChanged
    }
    const next = await readPlan(current);
    setPlan(next);
    return next;
  }, []);

  return { plan, loading, refresh };
}
