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
  build: {
    // 降低 chunk size 警告閾值，鼓勵更細粒度的拆分
    chunkSizeWarningLimit: 200,
    rollupOptions: {
      output: {
        manualChunks: {
          // Firebase Auth — 登入頁面首屏需要，獨立打包以利快取
          'vendor-firebase-auth': ['firebase/app', 'firebase/auth'],
          // Firebase Firestore — 進入 Dashboard/Chat 才需要
          'vendor-firebase-firestore': ['firebase/firestore'],
          // React 核心 — 所有頁面都需要
          'vendor-react': ['react', 'react-dom', 'react-router-dom'],
          // IndexedDB ORM — 只有 ChatPage 需要
          'vendor-dexie': ['dexie'],
        },
      },
    },
    // 啟用 CSS code splitting（每個 lazy page 獨立 CSS）
    cssCodeSplit: true,
    // 使用 esbuild minify（比 terser 快 20-100x，gzip 效果差異 < 2%）
    minify: 'esbuild',
    target: 'es2020',
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
        // P2P 與傳輸層
        'src/core/p2p/P2PConnectionManager.ts',
        'src/core/transport/MultiChannelBus.ts',
        'src/core/protocol/AckManager.ts',
        // Mesh 網路與安全
        'src/core/mesh/MeshTopologyManager.ts',
        'src/core/mesh/SecurityManager.ts',
        'src/core/mesh/IdentityManager.ts',
        'src/core/mesh/GossipMessageHandler.ts',
        'src/core/mesh/MeshGossipManager.ts',
        // Ledger 與 Chain
        'src/core/ledger/SharedLedgerEngine.ts',
        'src/core/ledger/ForkResolver.ts',
        'src/core/chain/ChainMergeService.ts',
        'src/core/chain/ChainSyncService.ts',
        // Feature 系統
        'src/core/features/FeatureRegistry.ts',
        'src/core/features/built-in/ChatFeature.ts',
        // 業務邏輯（純函式 / 可 mock 的服務）
        'src/features/chat/hooks/useP2PArchitecture.ts',
        'src/features/chat/hooks/useChatMessages.ts',
        'src/features/chat/MeshChatService.ts',
        'src/services/RoomService.ts',
        'src/services/RoomRequestService.ts',
      ],
      exclude: ['node_modules', 'tests'],
    },
  },
}));



