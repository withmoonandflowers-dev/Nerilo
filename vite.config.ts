/// <reference types="vitest/config" />
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';

export default defineConfig(({ mode }) => ({
  plugins: [react()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  server: {
    port: 3000,
    host: true,
  },
  define: {
    // 在測試模式下允許 guest 用戶建立房間
    'import.meta.env.VITE_ALLOW_GUEST_CREATE_ROOM': mode === 'test' ? '"true"' : 'undefined',
  },
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/unit/**/*.spec.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json-summary', 'html'],
      include: ['src/core/mesh/SharedDataStream.ts', 'src/utils/crypto.ts'],
      exclude: ['node_modules', 'tests'],
    },
  },
}));



