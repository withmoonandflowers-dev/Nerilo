import { describe, expect, it } from 'vitest';
import {
  cheapestQuote,
  nextCongestionPrice,
  storageCost,
  type CongestionPricingConfig,
} from '../../src/core/relay/CongestionPricing';

const CONFIG: CongestionPricingConfig = {
  targetUtilization: 0.7,
  adjustmentRate: 0.1,
  minPrice: 0.000_001,
  maxPrice: 10,
};

describe('CongestionPricing — Spec 001 T2', () => {
  it('高負載漲價、低負載降價、目標使用率價格不動', () => {
    expect(nextCongestionPrice(1, 0.9, CONFIG)).toBeCloseTo(1.02);
    expect(nextCongestionPrice(1, 0.5, CONFIG)).toBeCloseTo(0.98);
    expect(nextCongestionPrice(1, 0.7, CONFIG)).toBe(1);
  });

  it('任何觀測都受價格上下限約束', () => {
    expect(nextCongestionPrice(9.9, 100, CONFIG)).toBe(10);
    expect(nextCongestionPrice(0.000_001, 0, CONFIG)).toBe(0.000_001);
  });

  it('拒絕會造成反向更新或劇烈震盪的參數', () => {
    expect(() => nextCongestionPrice(1, 0.7, { ...CONFIG, adjustmentRate: 0 })).toThrow();
    expect(() => nextCongestionPrice(1, 0.7, { ...CONFIG, adjustmentRate: 1.01 })).toThrow();
    expect(() => nextCongestionPrice(1, 0.7, { ...CONFIG, targetUtilization: 1 })).toThrow();
  });

  it('固定總需求、需求流向較便宜信使時，各信使價格收斂（一價定律）', () => {
    let prices = [0.4, 1, 2.5];
    for (let round = 0; round < 400; round++) {
      const harmonicMean = prices.length / prices.reduce((sum, p) => sum + 1 / p, 0);
      prices = prices.map((price) => {
        // 價格低於市場水準會承接較多需求，反之承接較少；平均占用維持 u*。
        const utilization = CONFIG.targetUtilization * harmonicMean / price;
        return nextCongestionPrice(price, utilization, CONFIG);
      });
    }
    expect(Math.max(...prices) - Math.min(...prices)).toBeLessThan(0.000_1);
  });

  it('byte-day 計價不會把非零服務捨成免費', () => {
    expect(storageCost(0.001, 1000, 86_400_000)).toBe(1);
    expect(storageCost(0.000_001, 1, 1)).toBe(0.000_001);
    expect(storageCost(1, 0, 86_400_000)).toBe(0);
  });

  it('只在未過期報價中選最低價', () => {
    const now = 1000;
    const selected = cheapestQuote([
      { pricePerByteDay: 0.1, utilization: 0.5, expiresAt: 999, courier: 'expired' },
      { pricePerByteDay: 0.3, utilization: 0.5, expiresAt: 2000, courier: 'b' },
      { pricePerByteDay: 0.2, utilization: 0.8, expiresAt: 2000, courier: 'a' },
    ], now);
    expect(selected?.courier).toBe('a');
  });
});
