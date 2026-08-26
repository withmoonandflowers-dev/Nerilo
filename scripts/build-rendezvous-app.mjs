#!/usr/bin/env node
/** 把會合點內建聊天頁打成單一 HTML（Spec 027）：esbuild bundle + 內嵌進模板。 */
import { build } from 'esbuild';
import { readFileSync, writeFileSync } from 'node:fs';

const out = await build({
  entryPoints: ['tools/rendezvous-app/main.ts'],
  bundle: true,
  format: 'iife',
  minify: true,
  write: false,
  define: { 'import.meta.env.DEV': 'false', 'import.meta.env.MODE': '"production"', 'import.meta.env.VITE_DEBUG_ROOMS': 'undefined' },
});
const js = out.outputFiles[0].text;
const html = readFileSync('tools/rendezvous-app/template.html', 'utf8')
  .replace('__APP_JS__', () => js.replace(/<\/script>/g, '<\\/script>'));
writeFileSync('tools/rendezvous-app.html', html);
console.log(`tools/rendezvous-app.html 產出（${(html.length / 1024).toFixed(0)} KB）`);
