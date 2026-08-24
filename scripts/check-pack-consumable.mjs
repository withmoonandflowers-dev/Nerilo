#!/usr/bin/env node
/**
 * 發佈前閘門：把套件打包、裝進一個乾淨的臨時專案、用**純 Node**（非 Vite）載入兩個進入點。
 *
 * 為什麼需要它：2026-07-26 真實安裝實測發現 `nerilo/firestore` 一 import 就 TypeError——
 * `src/utils/logger.ts` 裸讀 `import.meta.env.DEV`，而那是 Vite 才會注入的東西。
 * repo 內的所有測試都跑在 Vite/Vitest 下，`import.meta.env` 一直存在，
 * 所以**整套測試無法察覺這個 bug**；只有從消費端裝一次才看得到。
 *
 * 這個閘門刻意不進 CI（npm pack + install 慢），是 publish 前必跑的一步。
 */
import { execSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ROOT = process.cwd();
const dir = mkdtempSync(join(tmpdir(), 'nerilo-pack-'));
let failed = false;

try {
  console.log(`[pack-smoke] 暫存目錄 ${dir}`);
  execSync('npm run build:sdk', { cwd: ROOT, stdio: 'ignore' });
  const tgz = execSync(`npm pack "${ROOT}" --pack-destination "${dir}"`, { encoding: 'utf8' })
    .trim()
    .split('\n')
    .pop();

  writeFileSync(
    join(dir, 'package.json'),
    JSON.stringify({ name: 'pack-smoke', private: true, type: 'module', version: '1.0.0' })
  );
  execSync(`npm install "${join(dir, tgz)}"`, { cwd: dir, stdio: 'ignore' });

  const probe = `
    const main = await import('nerilo');
    const fs = await import('nerilo/firestore');
    const tp = await import('nerilo/transport');
    if (typeof main.NeriloClient !== 'function') throw new Error('主入口缺 NeriloClient');
    if (typeof fs.createFirestoreSignaling !== 'function') throw new Error('subpath 缺 createFirestoreSignaling');
    if (typeof fs.createChatClient !== 'function') throw new Error('subpath 缺 createChatClient');
    if (typeof tp.createTransportClient !== 'function') throw new Error('transport 缺 createTransportClient');
    console.log('OK 主入口 ' + Object.keys(main).length + ' 個；firestore ' + Object.keys(fs).length + ' 個；transport ' + Object.keys(tp).length + ' 個');
  `;
  writeFileSync(join(dir, 'probe.mjs'), probe);
  const out = execSync('node probe.mjs', { cwd: dir, encoding: 'utf8' });
  console.log(`✓ [gate] 純 Node 消費者可載入三個進入點 — ${out.trim()}`);
} catch (err) {
  failed = true;
  console.error('✗ [gate] 套件在純 Node 消費端載入失敗：');
  console.error(err.stdout?.toString() || err.stderr?.toString() || err.message);
} finally {
  rmSync(dir, { recursive: true, force: true });
}

process.exit(failed ? 1 : 0);
