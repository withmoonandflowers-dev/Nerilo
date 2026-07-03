/**
 * 煙霧測試報告產生器。
 *
 * 讀取 smoke-artifacts/results.json（Playwright JSON reporter）與
 * smoke-artifacts/stats.jsonl（測試寫入的連線統計），產出
 * smoke-artifacts/SMOKE-REPORT.md。
 *
 * 用法：node scripts/smoke-report.mjs（通常經由 npm run smoke:prod 自動執行）
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as https from 'node:https';

const DIR = path.resolve(process.cwd(), 'smoke-artifacts');
const BASE_URL = process.env.SMOKE_BASE_URL ?? 'https://nerilo.web.app';

function fetchText(url) {
  return new Promise((resolve) => {
    https
      .get(url, (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => resolve(data));
      })
      .on('error', () => resolve(''));
  });
}

const results = JSON.parse(fs.readFileSync(path.join(DIR, 'results.json'), 'utf8'));
const statsLines = fs.existsSync(path.join(DIR, 'stats.jsonl'))
  ? fs
      .readFileSync(path.join(DIR, 'stats.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l))
  : [];

// 只取本次執行的 stats（results 的 startTime 之後）
const runStart = new Date(results.stats?.startTime ?? 0).getTime();
const stats = statsLines.filter((s) => new Date(s.at).getTime() >= runStart - 5_000);

const tests = [];
for (const suite of results.suites ?? []) {
  const walk = (s) => {
    for (const spec of s.specs ?? []) {
      const r = spec.tests?.[0]?.results?.[0];
      tests.push({
        title: spec.title,
        status: r?.status ?? 'unknown',
        durationMs: r?.duration ?? 0,
        error: r?.error?.message?.split('\n')[0] ?? null,
      });
    }
    for (const child of s.suites ?? []) walk(child);
  };
  walk(suite);
}

const html = await fetchText(BASE_URL);
const buildHash = html.match(/assets\/index-([a-zA-Z0-9_-]+)\.js/)?.[1] ?? 'unknown';

const statusIcon = (s) => (s === 'passed' ? 'PASS' : s === 'skipped' ? 'SKIP' : 'FAIL');
const allPassed = tests.length > 0 && tests.every((t) => t.status === 'passed');

const byScenario = Object.fromEntries(stats.map((s) => [s.scenario, s]));
const s1 = byScenario['S1-direct'];
const s2 = byScenario['S2-forced-turn'];

const fmtPc = (pcStats) =>
  (pcStats ?? [])
    .map((p) => `${p.connectionState}/${p.local ?? '?'}→${p.remote ?? '?'}${p.rttMs != null ? ` rtt=${p.rttMs}ms` : ''}`)
    .join('; ') || '無資料';

const lines = [];
lines.push(`# Nerilo Production 煙霧測試報告`);
lines.push('');
lines.push(`- 時間：${new Date().toISOString()}`);
lines.push(`- 目標：${BASE_URL}（build: \`${buildHash}\`）`);
lines.push(
  `- 總結：**${tests.length === 0 ? '異常：沒有任何測試被執行' : allPassed ? '全數通過' : '有失敗項，見下表'}**`
);
lines.push('');
lines.push(`| 場景 | 結果 | 耗時 | 備註 |`);
lines.push(`|---|---|---|---|`);
for (const t of tests) {
  lines.push(
    `| ${t.title} | ${statusIcon(t.status)} | ${(t.durationMs / 1000).toFixed(1)}s | ${t.error ?? ''} |`
  );
}
lines.push('');
lines.push(`## 連線品質`);
lines.push('');
if (s1) {
  lines.push(`- 直連訊息延遲（含 UI 渲染）：A→B ${s1.latencyMsAtoB}ms，B→A ${s1.latencyMsBtoA}ms`);
  lines.push(`- 直連 candidate：${fmtPc(s1.pcStats)}`);
}
if (s2) {
  lines.push(`- 強制 TURN 訊息延遲：${s2.latencyMs}ms`);
  lines.push(`- TURN candidate：${fmtPc(s2.pcStats)}`);
} else {
  lines.push(`- 強制 TURN：無統計資料（測試未完成即失敗時，代表 TURN 未設定或憑證失效）`);
}
lines.push('');
lines.push(`## 涵蓋範圍聲明`);
lines.push('');
lines.push(`本報告等效涵蓋：正式站認證流程、建房/加入、P2P 直連、TURN 中繼`);
lines.push(`（relay-only 等效模擬雙嚴格 NAT，即行動網路最壞情境）、E2EE 金鑰交換、`);
lines.push(`訊息雙向往返、降級誠實性。`);
lines.push('');
lines.push(`**尚未涵蓋（建議偶爾人工驗證）**：iOS Safari 的 WebRTC 行為、`);
lines.push(`實體電信商 NAT 特異性、TURN 月流量額度耗盡的退化、真實行動裝置的電力/背景限制。`);
lines.push('');

fs.writeFileSync(path.join(DIR, 'SMOKE-REPORT.md'), lines.join('\n'));
console.log(lines.join('\n'));
console.log(`\n報告已寫入 smoke-artifacts/SMOKE-REPORT.md`);
process.exit(allPassed ? 0 : 1);
