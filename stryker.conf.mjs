// Stryker mutation testing — 驗證測試「真的抓得到 bug」（harden-tests 建議 3）
/** @type {import('@stryker-mutator/api/core').PartialStrykerOptions} */
export default {
  testRunner: 'vitest',
  vitest: { configFile: 'vitest.unit.config.mjs' },
  mutate: ['src/core/mesh/antiEntropy.ts', 'src/core/mesh/RecordCrypto.ts'],
  reporters: ['clear-text', 'progress'],
  coverageAnalysis: 'perTest',
  concurrency: 4,
  timeoutMS: 20000,
};
