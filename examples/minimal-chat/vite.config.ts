import { defineConfig } from 'vite';
import { fileURLToPath, URL } from 'node:url';

// Reference 整合：把套件名 `nerilo` 指到 build 出來的 dist（＝ npm 消費者會拿到的東西）。
// 跑之前需先 `npm run build:sdk`（根目錄 example:minimal 腳本已自動先 build）。
export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  resolve: {
    alias: {
      nerilo: fileURLToPath(new URL('../../dist/index.js', import.meta.url)),
    },
  },
  server: { port: 5180, strictPort: true },
});
