import { defineConfig } from 'vitest/config';
import path from 'path';

/**
 * Vitest config for the mesh stress tests.
 *
 * Excluded from the default `npm run test:run` suite because:
 *  - It's slow (thousands of routed messages per scenario)
 *  - It's not a correctness gate — it's a regression check for the
 *    algorithmic claims about gossip + topology at 20+ peers
 *
 * Invoke with: `npm run test:stress`
 */
export default defineConfig({
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/stress/**/*.spec.ts'],
    // Stress runs can take longer than the default 5 s
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
