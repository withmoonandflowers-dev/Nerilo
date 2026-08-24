import { defineConfig } from 'vite';
import { fileURLToPath, URL } from 'node:url';

// Spec 026 T5：檔案傳輸驗證頁。套件名指到 dist，先 build:sdk。
export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  resolve: {
    alias: {
      'nerilo/transport': fileURLToPath(new URL('../../dist/transport.js', import.meta.url)),
      'nerilo/firestore': fileURLToPath(new URL('../../dist/firestore.js', import.meta.url)),
      nerilo: fileURLToPath(new URL('../../dist/index.js', import.meta.url)),
    },
  },
  server: { port: 5183, strictPort: true },
});
