#!/usr/bin/env node
/**
 * 修剪 SDK 發佈型別表面（架構收斂 2026-07）。
 *
 * tsc 會為整個 src 產 .d.ts（~186 檔），但 SDK 消費者只需從公開進入點
 * （dist/types/sdk/index.d.ts、firestore.d.ts）實際 import 可達的那幾檔。
 * 本腳本走這兩個進入點的 import 圖，刪掉所有不可達的 .d.ts，讓 npm 包不外洩內臟。
 *
 * 同時當「公開表面適應度函數」：可達檔數若異常暴增（內部悄悄外洩到公開型別），
 * 用 --max=<n> 讓 CI 紅。
 */
import { readFileSync, existsSync, rmSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, normalize, relative } from 'node:path';

const ROOT = 'dist/types';
const ENTRIES = [`${ROOT}/sdk/index.d.ts`, `${ROOT}/sdk/firestore.d.ts`];
const maxArg = process.argv.find((a) => a.startsWith('--max='));
const MAX = maxArg ? Number(maxArg.split('=')[1]) : Infinity;

function importsOf(file) {
  const src = readFileSync(file, 'utf8');
  const out = [];
  for (const m of src.matchAll(/from\s+['"](\.[^'"]+)['"]/g)) {
    const base = normalize(join(dirname(file), m[1]));
    for (const cand of [`${base}.d.ts`, join(base, 'index.d.ts')]) {
      if (existsSync(cand)) { out.push(cand); break; }
    }
  }
  return out;
}

// 走可達集
const reachable = new Set();
const stack = [...ENTRIES];
while (stack.length) {
  const f = stack.pop();
  if (reachable.has(f) || !existsSync(f)) continue;
  reachable.add(f);
  stack.push(...importsOf(f));
}

// 列出所有 .d.ts
function allDts(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...allDts(p));
    else if (name.endsWith('.d.ts')) out.push(p);
  }
  return out;
}

const all = allDts(ROOT);
const toDelete = all.filter((f) => !reachable.has(f));
for (const f of toDelete) rmSync(f);

// 清空目錄
function pruneEmptyDirs(dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) pruneEmptyDirs(p);
  }
  if (readdirSync(dir).length === 0 && dir !== ROOT) rmSync(dir, { recursive: true });
}
pruneEmptyDirs(ROOT);

console.log(`[prune-sdk-types] 保留 ${reachable.size} / ${all.length} 檔（刪 ${toDelete.length}）`);
for (const f of [...reachable].sort()) console.log('  ✓', relative(ROOT, f));

if (reachable.size > MAX) {
  console.error(`[prune-sdk-types] 公開型別表面 ${reachable.size} 檔 > 上限 ${MAX}——可能有內部型別外洩到公開 API。`);
  process.exit(1);
}
