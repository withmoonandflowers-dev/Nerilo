import { defineConfig } from 'vitest/config';

/**
 * 整合測試設定
 *
 * 使用方式：
 *   npm run test:integration          → 需先啟動 Firebase Emulator
 *   npm run test:emulator             → 自動啟動 Emulator 後執行（需安裝 firebase-tools）
 *
 * Emulator 啟動：
 *   firebase emulators:start --only auth,firestore
 *
 * 環境變數（已由 emulator.ts 自動設定）：
 *   FIRESTORE_EMULATOR_HOST=127.0.0.1:8080
 *   FIREBASE_AUTH_EMULATOR_HOST=127.0.0.1:9099
 */
export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/integration/**/*.spec.ts'],
    setupFiles: ['tests/integration/helpers/emulator-env.ts'],
    testTimeout: 30_000,
    hookTimeout: 30_000,
    reporters: ['verbose'],
    // Vitest 4: 使用 threads 取代棄用的 poolOptions.forks
    // 序列執行避免 Emulator 狀態干擾
    sequence: { concurrent: false },
    fileParallelism: false,
  },
});
