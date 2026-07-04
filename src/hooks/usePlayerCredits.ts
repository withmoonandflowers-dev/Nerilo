/**
 * usePlayerCredits — 反應式讀取本機點數餘額（ADR-0020）
 *
 * 薄封裝 creditEconomy singleton：init 綁定 uid、訂閱餘額變化。
 * 花點數請直接呼叫 creditEconomy.trySpend（回傳成功與否）。
 * 框架無關的邏輯全在 CreditEconomy；此 hook 僅 React 綁定，Vue 版可平行實作。
 */
import { useState, useEffect } from 'react';
import { creditEconomy } from '../core/incentive/CreditEconomy';
import type { CreditBalance, ServiceTier } from '../core/relay/types';

export interface PlayerCredits {
  balance: number;
  tier: ServiceTier;
  loading: boolean;
}

export function usePlayerCredits(uid: string | null | undefined): PlayerCredits {
  const [balance, setBalance] = useState<number>(0);
  const [tier, setTier] = useState<ServiceTier>('free');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!uid) {
      setLoading(false);
      return;
    }
    let active = true;
    creditEconomy.init(uid);

    const refresh = async () => {
      const [b, t] = await Promise.all([creditEconomy.getBalance(), creditEconomy.getServiceTier()]);
      if (!active) return;
      if (b) setBalance(b.balance);
      setTier(t);
      setLoading(false);
    };
    void refresh();

    const unsub = creditEconomy.subscribe((b: CreditBalance) => {
      if (!active) return;
      setBalance(b.balance);
      void creditEconomy.getServiceTier().then((t) => active && setTier(t));
    });

    return () => {
      active = false;
      unsub();
    };
  }, [uid]);

  return { balance, tier, loading };
}
