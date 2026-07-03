import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/unit/**/*.spec.ts'],
    // ADR-0007 凍結模組：CI 維持編譯（tsc 仍涵蓋），停跑其單元測試。
    // 解凍時從此清單移除並更新對應目錄的 FROZEN.md。
    exclude: [
      '**/node_modules/**',
      'tests/unit/GameLoop.spec.ts',
      'tests/unit/GameNetworkSync.spec.ts',
      'tests/unit/GameWorld.spec.ts',
      'tests/unit/CommunityManager.spec.ts',
      'tests/unit/ChainMerge.spec.ts',
      'tests/unit/SharedLedgerEngine.spec.ts',
    ],
    pool: 'forks',
  },
});
