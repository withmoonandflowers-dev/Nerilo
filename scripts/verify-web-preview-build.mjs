import fs from 'node:fs';
import path from 'node:path';

function fail(message) {
  console.error(`[preview-build] ${message}`);
  process.exit(1);
}

const options = {};
for (let index = 2; index < process.argv.length; index += 2) {
  const key = process.argv[index];
  const value = process.argv[index + 1];
  if (!key?.startsWith('--') || !value) fail(`Unknown or incomplete option: ${key}`);
  options[key.slice(2)] = value;
}

const outputDir = path.resolve(options.dir ?? '');
const expectedProject = options.project;
const expectedAuthDomain = options['auth-domain'];
const forbiddenAuthDomain = options['forbid-auth-domain'];

if (!outputDir || !expectedProject || !expectedAuthDomain || !forbiddenAuthDomain) {
  fail('Required options: --dir, --project, --auth-domain, --forbid-auth-domain.');
}
if (!fs.existsSync(path.join(outputDir, 'index.html'))) {
  fail(`Missing generated index.html under ${outputDir}.`);
}

const searchableExtensions = new Set(['.html', '.js', '.json']);
let generatedText = '';
const executableInlineScripts = [];
const pending = [outputDir];
while (pending.length > 0) {
  const current = pending.pop();
  for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
    const child = path.join(current, entry.name);
    if (entry.isDirectory()) pending.push(child);
    else if (searchableExtensions.has(path.extname(entry.name))) {
      const contents = fs.readFileSync(child, 'utf8');
      generatedText += contents;
      if (path.extname(entry.name) === '.html') {
        const inlineScriptPattern = /<script\b(?![^>]*\bsrc\s*=)([^>]*)>([\s\S]*?)<\/script>/gi;
        for (const match of contents.matchAll(inlineScriptPattern)) {
          const attributes = match[1] ?? '';
          const source = match[2]?.trim() ?? '';
          if (!source || /\btype=["']application\/(?:json|ld\+json)["']/i.test(attributes)) continue;
          executableInlineScripts.push(path.relative(outputDir, child));
        }
      }
    }
  }
}

if (!generatedText.includes(expectedProject)) {
  fail(`Generated output does not contain expected project "${expectedProject}".`);
}
if (!generatedText.includes(expectedAuthDomain)) {
  fail(`Generated output does not contain expected auth domain "${expectedAuthDomain}".`);
}
if (generatedText.includes(forbiddenAuthDomain)) {
  fail(`Generated output contains forbidden production auth domain "${forbiddenAuthDomain}".`);
}
if (executableInlineScripts.length > 0) {
  fail(
    `Generated output contains CSP-blocked executable inline scripts: ${[
      ...new Set(executableInlineScripts),
    ].join(', ')}.`
  );
}

console.log(`[preview-build] Output is pinned to Firebase project "${expectedProject}".`);
