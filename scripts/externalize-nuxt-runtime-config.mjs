import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const outputDir = path.resolve(process.argv[2] ?? '.output/public');
const assetDir = path.join(outputDir, '_nuxt');
const htmlFiles = [];
const pending = [outputDir];

if (!fs.existsSync(path.join(outputDir, 'index.html'))) {
  throw new Error(`Missing generated index.html under ${outputDir}`);
}

while (pending.length > 0) {
  const current = pending.pop();
  for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
    const child = path.join(current, entry.name);
    if (entry.isDirectory()) pending.push(child);
    else if (entry.name.endsWith('.html')) htmlFiles.push(child);
  }
}

const runtimePattern =
  /<script>(window\.__NUXT__=\{\};window\.__NUXT__\.config=[\s\S]*?)<\/script>/g;
const writtenAssets = new Map();
let replacementCount = 0;

for (const htmlFile of htmlFiles) {
  const original = fs.readFileSync(htmlFile, 'utf8');
  const rewritten = original.replace(runtimePattern, (_match, runtimeSource) => {
    const digest = crypto.createHash('sha256').update(runtimeSource).digest('hex').slice(0, 16);
    const assetName = `runtime-config.${digest}.js`;
    const existingSource = writtenAssets.get(assetName);
    if (existingSource && existingSource !== runtimeSource) {
      throw new Error(`Runtime config digest collision for ${assetName}`);
    }
    if (!existingSource) {
      fs.mkdirSync(assetDir, { recursive: true });
      fs.writeFileSync(path.join(assetDir, assetName), `${runtimeSource}\n`);
      writtenAssets.set(assetName, runtimeSource);
    }
    replacementCount += 1;
    return `<script src="/_nuxt/${assetName}"></script>`;
  });

  if (rewritten !== original) fs.writeFileSync(htmlFile, rewritten);
}

if (replacementCount === 0) {
  throw new Error('Nuxt runtime config inline script was not found; generated output format changed');
}

console.log(
  `[preview-csp] Externalized ${replacementCount} runtime config scripts into ${writtenAssets.size} immutable asset(s).`
);
