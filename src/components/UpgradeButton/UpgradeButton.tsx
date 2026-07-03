/**
 * 升級 Pro 按鈕 / Pro 徽章（ADR-0008 付費牆入口）。
 *
 * 結帳走 Lemon Squeezy hosted checkout（MoR，稅務由其代收代付）。
 * checkout URL 帶 custom uid，webhook 據此把 plan=pro 寫回 custom claims。
 * 匿名使用者不顯示（沒有穩定帳號可綁訂閱）。
 */
import { useAuth } from '../../contexts/AuthContext';
import { usePlan } from '../../hooks/usePlan';
import { featureLog } from '../../utils/featureLog';
import './UpgradeButton.css';

const CHECKOUT_URL = import.meta.env.VITE_LS_CHECKOUT_URL as string | undefined;

export function UpgradeButton() {
  const { user } = useAuth();
  const { plan, loading } = usePlan();

  if (loading || !user || user.role === 'guest') return null;

  if (plan === 'pro') {
    return (
      <span className="plan-badge plan-badge-pro" role="status" title="Nerilo Pro 訂閱生效中">
        Pro
      </span>
    );
  }

  if (!CHECKOUT_URL) return null; // 未設定結帳連結的環境（例如模擬器 E2E）不顯示

  const handleUpgrade = () => {
    featureLog('billing', 'upgrade_click', { uid: user.uid });
    const url = new URL(CHECKOUT_URL);
    url.searchParams.set('checkout[custom][uid]', user.uid);
    if (user.email) url.searchParams.set('checkout[email]', user.email);
    window.open(url.toString(), '_blank', 'noopener');
  };

  return (
    <button type="button" className="btn-upgrade" onClick={handleUpgrade}>
      升級 Pro
    </button>
  );
}
