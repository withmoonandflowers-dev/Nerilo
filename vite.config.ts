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
      include: [
        // 核心工具
        'src/utils/crypto.ts',
        'src/utils/uuid.ts',
        // 核心資料結構
        'src/core/mesh/SharedDataStream.ts',
        // 業務邏輯（純函式 / 可 mock 的服務）
        'src/features/chat/hooks/useP2PArchitecture.ts',
        'src/features/chat/hooks/useChatMessages.ts',
        'src/features/chat/MeshChatService.ts',
        'src/services/RoomService.ts',
      ],
      exclude: ['node_modules', 'tests'],
    },
  },
}));



