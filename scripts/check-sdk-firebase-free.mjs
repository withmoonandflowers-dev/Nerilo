#!/usr/bin/env node
/**
 * QA gate（稽核不變量 → 自動化）：SDK 進入點必須脫離 Firebase。
 *
 * 檢查兩件事，任一破就以非零退出擋 CI：
 *  1. MeshChatService 的靜態(value)import 圖不得可達任何 firebase 檔（型別 import 抹除不算）。
 *  2. build:sdk 產的 dist/index.js（eager 進入點）不得含 firebase 靜態 import。
 *     （第 2 項需先 npm run build:sdk；未產 dist 則跳過並警告，不擋。）
 *
 * 對應 core-invariants-assessment.md R8 的硬閘化。純靜態分析，無需執行 App。
 */
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join, normalize } from 'node:path';

const ROOT = process.cwd();
const IMPORT_RE = /^\s*(?:import|export)\s+(type\s+)?[^'"]*?from\s+['"]([^'"]+)['"]/;
const DYN_RE = /import\(\s*['"]([^'"]+)['"]\s*\)/g;

function resolve(imp, fromFile) {
  let base;
  if (imp.startsWith('.')) base = normalize(join(dirname(fromFile), imp));
  else if (imp.startsWith('@/')) base = normalize(join('src', imp.slice(2)));
  else return null; // bare (node_modules) — 交給 isFirebase 判斷，不遞迴
  for (const c of [base, base + '.ts', base + '.tsx', join(base, 'index.ts')]) {
    if (existsSync(join(ROOT, c))) return c;
  }
  return null;
}

const isFirebase = (imp) => imp.startsWith('firebase/') || /config\/firebase/.test(imp);

/** BFS 靜態 value-import 圖，回傳可達的 firebase import（跳過 type-only 與 dynamic import）。 */
function firebaseReachable(entry) {
  const seen = new Set();
  const hits = [];
  const stack = [entry];
  while (stack.length) {
    const f = stack.pop();
    if (seen.has(f)) continue;
    seen.add(f);
    let src;
    try { src = readFileSync(join(ROOT, f), 'utf8'); } catch { continue; }
    // 移除 dynamic import 的行不需要——我們只掃靜態 import 語句列，dynamic 天生不在其中。
    for (const line of src.split('\n')) {
      const m = IMPORT_RE.exec(line);
      if (!m) continue;
      const isType = Boolean(m[1]);
      const imp = m[2];
      if (isType) continue;            // 型別 import 編譯後抹除
      if (isFirebase(imp)) hits.push({ file: f, imp });
      const r = resolve(imp, f);
      if (r) stack.push(r);
    }
  }
  return { hits, scanned: seen.size };
}

let failed = false;

// ── 檢查 1：MeshChatService 靜態圖 ──
const ENTRY = 'src/features/chat/MeshChatService.ts';
const { hits, scanned } = firebaseReachable(ENTRY);
if (hits.length > 0) {
  failed = true;
  console.error(`✗ [gate] ${ENTRY} 靜態圖可達 ${hits.length} 個 firebase import（掃過 ${scanned} 檔）：`);
  for (const h of hits) console.error(`    ${h.file} -> ${h.imp}`);
  console.error('  → 預設 firebase adapter 必須改為 initialize() 內動態 import()。見 ADR-0025 P3-final。');
} else {
  console.log(`✓ [gate] ${ENTRY} 靜態圖無 firebase（掃過 ${scanned} 檔）`);
}

// ── 檢查 2：dist/index.js eager 進入點 ──
const DIST = 'dist/index.js';
if (existsSync(join(ROOT, DIST))) {
  const built = readFileSync(join(ROOT, DIST), 'utf8');
  // eager bundle 內不得出現 firebase 的靜態 import；firebase 應只在 --splitting 的動態 chunk。
  const matches = built.match(/from\s*["'](firebase\/[^"']+|[^"']*config\/firebase[^"']*)["']/g) || [];
  if (matches.length > 0) {
    failed = true;
    console.error(`✗ [gate] ${DIST} eager 進入點含 firebase 靜態 import：${matches.join(', ')}`);
    console.error('  → 確認 build:sdk 有 --splitting，且只有動態 import() 觸及 firebase。');
  } else {
    console.log(`✓ [gate] ${DIST} eager 進入點無 firebase 靜態 import`);
  }
} else {
  console.warn(`⚠ [gate] ${DIST} 不存在，跳過 dist 檢查（CI 請先跑 npm run build:sdk）`);
}

process.exit(failed ? 1 : 0);
