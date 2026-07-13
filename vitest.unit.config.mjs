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
      // game/ 於 ADR-0015 解凍（遊戲資料流成為第二參考應用），測試恢復
      'tests/unit/CommunityManager.spec.ts',
      'tests/unit/ChainMerge.spec.ts',
      'tests/unit/SharedLedgerEngine.spec.ts',
    ],
    pool: 'forks',
    coverage: {
      provider: 'v8',
      reporter: ['text-summary', 'html', 'json-summary'],
      // 只量測核心邏輯層（協議/服務/工具），不含 UI/型別/入口——避免用「跑得到但不
      // 該高覆蓋」的檔案稀釋分母，讓數字反映真正重要的協議層。
      include: ['src/core/**/*.ts', 'src/services/**/*.ts', 'src/utils/**/*.ts'],
      exclude: ['**/*.spec.ts', 'src/**/index.ts', '**/types.ts'],
      // 門檻＝迴歸地板（棘輪只升不降，見 .claude/skills/harden-tests）。
      // 量測 2026-07-06（P2-②c keyx live 接線後，含 RoomKeyCoordinator/GossipKeyx 單元）：
      //   Lines 62.6 / Stmts 61.3 / Funcs 61.8 / Branches 55.9。
      // 地板設現況略下（留緩衝避免 v8 逐次微幅波動誤觸 CI 紅）；有意義的提升就上調。
      thresholds: {
        lines: 60,
        statements: 59,
        functions: 59,
        branches: 53,
      },
    },
  },
});
