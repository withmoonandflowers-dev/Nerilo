#!/usr/bin/env node
/**
 * Spec 031 D-Q2：背書鏈完整驗證耗時量測。
 * 對鏈長 1、2、4、8、16、32、64 各建一條真簽章鏈（ECDSA P-256），
 * 呼叫 verifyEndorsementChain 驗整條鏈 N 次（預設 30），報 p50 / p95 / max。
 *
 * 用 esbuild 把 src/core/incentive/ServiceIOU.ts 打包到暫存檔再載入，跑的是產品原始碼，
 * 不放進 tests/unit，以免拉長 npm run test:run 並把機器負載帶進品質閘門。
 *
 * 用法：node scripts/measure-endorsement-chain.mjs [runs] [warmup]
 */
import { build } from 'esbuild';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir, cpus, loadavg } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { randomUUID, webcrypto } from 'node:crypto';
import { performance } from 'node:perf_hooks';

const RUNS = Number(process.argv[2] ?? 30);
const WARMUP = Number(process.argv[3] ?? 3);
const LENGTHS = [1, 2, 4, 8, 16, 32, 64];

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = mkdtempSync(join(tmpdir(), 'nerilo-chain-'));
const outFile = join(outDir, 'bundle.mjs');

await build({
  stdin: {
    contents: `
      export * from './src/core/incentive/ServiceIOU';
      export { ecdsaSigner } from './src/core/relay/CourierReceipts';
      export { senderIdFromPubKey } from './src/core/relay/TombstoneCrypto';
      export { arrayBufferToBase64 } from './src/utils/crypto';
    `,
    resolveDir: root,
    loader: 'ts',
  },
  bundle: true,
  platform: 'node',
  format: 'esm',
  outfile: outFile,
  alias: { '@': join(root, 'src') },
  define: { 'import.meta.env.DEV': 'false', 'import.meta.env.PROD': 'true', 'import.meta.env.MODE': '"production"' },
  logLevel: 'error',
});

const m = await import(pathToFileURL(outFile).href);
rmSync(outDir, { recursive: true, force: true });

const subtle = (globalThis.crypto ?? webcrypto).subtle;

async function node() {
  const keys = await subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const pubKey = m.arrayBufferToBase64(await subtle.exportKey('spki', keys.publicKey));
  return { nodeId: await m.senderIdFromPubKey(pubKey), pubKey, sign: m.ecdsaSigner(keys.privateKey) };
}
const party = (n) => ({ nodeId: n.nodeId, pubKey: n.pubKey });

async function makeChain(length) {
  const nodes = [];
  for (let i = 0; i < length + 2; i++) nodes.push(await node());
  const [issuer, holder] = nodes;
  const issuedAt = Date.now() - 1_000;
  const iou = await m.createServiceIOU({
    v: 'nsiou1',
    iouId: randomUUID(),
    kind: 'endorsable',
    issuer: party(issuer),
    holder: party(holder),
    denomination: { unit: 'custody-byte-days', amount: 1 },
    issuedAt,
    expiresAt: issuedAt + 3_600_000,
    nonce: randomUUID(),
  }, issuer.sign);
  const chain = [];
  let prevHash = await m.iouHash(iou);
  for (let i = 0; i < length; i++) {
    const from = nodes[i + 1];
    const to = nodes[i + 2];
    const e = await m.createEndorsement({
      v: 'nsend1',
      iouId: iou.iouId,
      seq: i + 1,
      from: party(from),
      toNodeId: to.nodeId,
      prevHash,
      swapPairHash: null,
      endorsedAt: Date.now(),
      nonce: randomUUID(),
    }, from.sign);
    chain.push(e);
    prevHash = await m.endorsementHash(e);
  }
  return { iou, chain, finalHolder: nodes[length + 1].nodeId };
}

function pct(sorted, p) {
  // nearest-rank
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx];
}

console.log(`node ${process.version}, ${cpus()[0]?.model ?? '?'} x${cpus().length}, loadavg ${loadavg().map((x) => x.toFixed(2)).join(' ')}`);
console.log(`runs=${RUNS} warmup=${WARMUP}（每個鏈長固定同一條鏈重驗）`);
console.log('len\tp50_ms\tp95_ms\tmax_ms\tper_link_p50_ms\tchain_json_bytes');

for (const len of LENGTHS) {
  const { iou, chain, finalHolder } = await makeChain(len);
  for (let i = 0; i < WARMUP; i++) await m.verifyEndorsementChain(iou, chain, { now: Date.now() });
  const samples = [];
  for (let i = 0; i < RUNS; i++) {
    const t0 = performance.now();
    const r = await m.verifyEndorsementChain(iou, chain, { now: Date.now() });
    samples.push(performance.now() - t0);
    if (!r.ok || r.holderNodeId !== finalHolder) {
      console.error(`len=${len} 驗證失敗`, r);
      process.exit(1);
    }
  }
  samples.sort((a, b) => a - b);
  const p50 = pct(samples, 50);
  console.log(`${len}\t${p50.toFixed(2)}\t${pct(samples, 95).toFixed(2)}\t${samples.at(-1).toFixed(2)}\t${(p50 / len).toFixed(3)}\t${Buffer.byteLength(JSON.stringify(chain))}`);
}
