/**
 * 分散式擁擠定價（Spec 001 T2）。
 *
 * 每個信使只看自己的占用率調價，不需要全域喊價者。函式刻意無 I/O、無時間與
 * 帳本依賴，讓模擬器、CourierService 與未來其他實作共用同一條價格曲線。
 */

export interface CongestionPricingConfig {
  /** 希望長期維持的占用率，需在 (0, 1) 內。 */
  targetUtilization: number;
  /** 每輪調整速度，需在 (0, 1] 內；越大反應越快，也越容易震盪。 */
  adjustmentRate: number;
  /** 每 byte-day 最低點數價格。 */
  minPrice: number;
  /** 每 byte-day 最高點數價格。 */
  maxPrice: number;
}

export const DEFAULT_CONGESTION_PRICING: CongestionPricingConfig = {
  targetUtilization: 0.7,
  adjustmentRate: 0.1,
  minPrice: 0.000_001,
  maxPrice: 1,
};

export interface CourierQuote {
  /** 每 byte-day 點數價格。 */
  pricePerByteDay: number;
  /** 報價時的本地占用率，供選擇與診斷，不是全域真相。 */
  utilization: number;
  /** 報價有效期限（Unix ms）；協議層可拒絕過期報價。 */
  expiresAt: number;
}

function finite(name: string, value: number): void {
  if (!Number.isFinite(value)) throw new RangeError(`${name} 必須是有限數`);
}

export function validateCongestionPricing(config: CongestionPricingConfig): void {
  finite('targetUtilization', config.targetUtilization);
  finite('adjustmentRate', config.adjustmentRate);
  finite('minPrice', config.minPrice);
  finite('maxPrice', config.maxPrice);
  if (config.targetUtilization <= 0 || config.targetUtilization >= 1) {
    throw new RangeError('targetUtilization 必須在 (0, 1) 內');
  }
  if (config.adjustmentRate <= 0 || config.adjustmentRate > 1) {
    throw new RangeError('adjustmentRate 必須在 (0, 1] 內');
  }
  if (config.minPrice <= 0 || config.maxPrice < config.minPrice) {
    throw new RangeError('價格上下限無效');
  }
}

/** p(t+1) = clamp(p(t) * [1 + lambda * (u(t) - u*)], pMin, pMax)。 */
export function nextCongestionPrice(
  currentPrice: number,
  utilization: number,
  config: CongestionPricingConfig = DEFAULT_CONGESTION_PRICING
): number {
  validateCongestionPricing(config);
  finite('currentPrice', currentPrice);
  finite('utilization', utilization);
  if (currentPrice <= 0) throw new RangeError('currentPrice 必須 > 0');

  // 占用率是觀測值；短暫超賣可 >1，但負值沒有物理意義，收斂為 0。
  const observed = Math.max(0, utilization);
  const raw = currentPrice * (1 + config.adjustmentRate * (observed - config.targetUtilization));
  return Math.min(config.maxPrice, Math.max(config.minPrice, raw));
}

/** 將 byte 與保存時間換成點數；向上取到 1e-6，避免非零服務被浮點捨成免費。 */
export function storageCost(pricePerByteDay: number, bytes: number, durationMs: number): number {
  finite('pricePerByteDay', pricePerByteDay);
  finite('bytes', bytes);
  finite('durationMs', durationMs);
  if (pricePerByteDay < 0 || bytes < 0 || durationMs < 0) throw new RangeError('計價輸入不得為負');
  if (pricePerByteDay === 0 || bytes === 0 || durationMs === 0) return 0;
  const days = durationMs / 86_400_000;
  return Math.ceil(pricePerByteDay * bytes * days * 1_000_000) / 1_000_000;
}

/** 消費者在有效報價中選最低價；同價時保持輸入順序，讓上層自行做多樣性排序。 */
export function cheapestQuote<T extends CourierQuote>(quotes: readonly T[], now: number): T | null {
  finite('now', now);
  let best: T | null = null;
  for (const quote of quotes) {
    if (quote.expiresAt < now || quote.pricePerByteDay < 0 || !Number.isFinite(quote.pricePerByteDay)) continue;
    if (!best || quote.pricePerByteDay < best.pricePerByteDay) best = quote;
  }
  return best;
}
