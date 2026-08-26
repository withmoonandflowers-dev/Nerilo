import { defineConfig } from 'vite';
import { fileURLToPath, URL } from 'node:url';
import basicSsl from '@vitejs/plugin-basic-ssl';

// Spec 027：QR 場測頁。
// 預設 http（localhost 是安全來源，相機可用；自測不需相機）。
// 跨裝置場測（手機相機）：QR_HTTPS=1 npm run example:qr → https://<區網IP>:5185
// （getUserMedia 只在安全來源可用；手機接受一次自簽憑證警告即可）。
const useHttps = process.env.QR_HTTPS === '1';
export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  plugins: useHttps ? [basicSsl()] : [],
  resolve: {
    alias: {
      'nerilo/transport': fileURLToPath(new URL('../../dist/transport.js', import.meta.url)),
      'nerilo/firestore': fileURLToPath(new URL('../../dist/firestore.js', import.meta.url)),
      nerilo: fileURLToPath(new URL('../../dist/index.js', import.meta.url)),
    },
  },
  server: { port: 5185, strictPort: true, host: '0.0.0.0', ...(useHttps ? { https: {} } : {}) },
});
