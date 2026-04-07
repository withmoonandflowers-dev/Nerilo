import { describe, it, expect, beforeEach } from 'vitest';
import { LocalCreditProvider } from '../../src/core/incentive/LocalCreditProvider';

describe('LocalCreditProvider', () => {
  let credits: LocalCreditProvider;

  beforeEach(() => {
    credits = new LocalCreditProvider();
  });

  describe('initial balance', () => {
    it('gives new nodes initial credits', async () => {
      const balance = await credits.getBalance('new-node');
      expect(balance.balance).toBe(100); // INITIAL_CREDITS
      expect(balance.earned).toBe(100);
      expect(balance.spent).toBe(0);
    });
  });

  describe('relay recording', () => {
    it('credits relay node for successful relay', async () => {
      await credits.recordRelay('relay-node', 'requester', 10240, 'proof');
      const balance = await credits.getBalance('relay-node');
      // 10240 bytes = 10 KB → 10 * 1 (perKb) + 5 (bonus) = 15 credits + 100 initial
      expect(balance.earned).toBe(115);
      expect(balance.balance).toBe(115);
    });

    it('creates receipt for relay event', async () => {
      const receipt = await credits.recordRelay('relay-node', 'requester', 1024, 'proof');
      expect(receipt.relayNodeId).toBe('relay-node');
      expect(receipt.requesterNodeId).toBe('requester');
      expect(receipt.bytesRelayed).toBe(1024);
    });
  });

  describe('credit deduction', () => {
    it('deducts credits for sending', async () => {
      const result = await credits.deductCredits('sender', 50);
      expect(result).toBe(true);
      const balance = await credits.getBalance('sender');
      expect(balance.balance).toBe(50); // 100 initial - 50
      expect(balance.spent).toBe(50);
    });

    it('rejects deduction that would exceed minimum balance', async () => {
      // Initial: 100, min: -100, so max deduction = 200
      const result = await credits.deductCredits('sender', 250);
      expect(result).toBe(false);
    });

    it('allows limited debt', async () => {
      const result = await credits.deductCredits('sender', 190);
      expect(result).toBe(true);
      const balance = await credits.getBalance('sender');
      expect(balance.balance).toBe(-90); // 100 - 190
    });
  });

  describe('canRelay', () => {
    it('allows relay for nodes with positive balance', async () => {
      expect(await credits.canRelay('new-node')).toBe(true);
    });

    it('blocks relay for nodes at minimum balance', async () => {
      await credits.deductCredits('poor-node', 200);
      expect(await credits.canRelay('poor-node')).toBe(false);
    });
  });

  describe('service tiers', () => {
    it('assigns free tier for negative balance', async () => {
      await credits.deductCredits('poor-node', 150);
      expect(await credits.getServiceTier('poor-node')).toBe('free');
    });

    it('assigns basic tier for positive balance', async () => {
      expect(await credits.getServiceTier('new-node')).toBe('basic');
    });

    it('assigns premium tier for high balance', async () => {
      // Use custom provider with lower premium threshold
      const customCredits = new LocalCreditProvider({}, { basicMin: 0, premiumMin: 200 });
      // Earn credits via relaying
      for (let i = 0; i < 20; i++) {
        await customCredits.recordRelay('rich-node', 'req', 10240, 'proof');
      }
      // Also add uptime credits
      customCredits.recordUptime('rich-node', 5);
      expect(await customCredits.getServiceTier('rich-node')).toBe('premium');
    });
  });

  describe('uptime credits', () => {
    it('awards uptime credits', async () => {
      credits.recordUptime('relay-node', 2); // 2 hours
      const balance = await credits.getBalance('relay-node');
      expect(balance.earned).toBe(120); // 100 initial + 2 * 10
    });
  });

  describe('earning throttle', () => {
    it('throttles excessive earning', async () => {
      // Try to earn more than MAX_EARN_PER_HOUR (500)
      const initialBalance = (await credits.getBalance('greedy-node')).balance;
      for (let i = 0; i < 100; i++) {
        await credits.recordRelay('greedy-node', 'req', 102400, 'proof');
      }
      const finalBalance = (await credits.getBalance('greedy-node')).balance;
      // Should be capped — not all 100 relays credited
      expect(finalBalance - initialBalance).toBeLessThanOrEqual(500);
    });
  });

  describe('export / import', () => {
    it('exports and imports balances', async () => {
      await credits.recordRelay('node-1', 'req', 1024, 'proof');
      const exported = credits.exportBalances();

      const newCredits = new LocalCreditProvider();
      newCredits.importBalances(exported);

      const balance = await newCredits.getBalance('node-1');
      expect(balance.earned).toBeGreaterThan(100);
    });
  });

  describe('receipts', () => {
    it('retrieves node-specific receipts', async () => {
      await credits.recordRelay('node-a', 'node-b', 1024, 'proof');
      await credits.recordRelay('node-c', 'node-d', 1024, 'proof');

      const receipts = credits.getNodeReceipts('node-a');
      expect(receipts).toHaveLength(1);
      expect(receipts[0].relayNodeId).toBe('node-a');
    });
  });
});
