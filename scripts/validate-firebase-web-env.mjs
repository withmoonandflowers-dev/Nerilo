import fs from 'node:fs';
import path from 'node:path';

const REQUIRED_KEYS = [
  'VITE_FIREBASE_API_KEY',
  'VITE_FIREBASE_AUTH_DOMAIN',
  'VITE_FIREBASE_PROJECT_ID',
  'VITE_FIREBASE_STORAGE_BUCKET',
  'VITE_FIREBASE_MESSAGING_SENDER_ID',
  'VITE_FIREBASE_APP_ID',
];
const CONTROL_KEYS = ['VITE_USE_EMULATOR'];

function fail(message) {
  console.error(`[deploy-env] ${message}`);
  process.exit(1);
}

function parseDotenv(contents) {
  const result = {};
  for (const rawLine of contents.split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;

    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/u.exec(line);
    if (!match) continue;

    let value = match[2].trim();
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1);
    } else {
      value = value.replace(/\s+#.*$/u, '').trim();
    }
    result[match[1]] = value;
  }
  return result;
}

const envFiles = [];
let expectedProject = '';
let label = 'web deployment';

for (let index = 2; index < process.argv.length; index += 1) {
  const argument = process.argv[index];
  const value = process.argv[index + 1];
  if (argument === '--from' && value) {
    envFiles.push(value);
    index += 1;
  } else if (argument === '--project' && value) {
    expectedProject = value;
    index += 1;
  } else if (argument === '--label' && value) {
    label = value;
    index += 1;
  } else {
    fail(`Unknown or incomplete option: ${argument}`);
  }
}

if (!expectedProject) fail('Missing required --project value.');

let loadedFileCount = 0;
const values = {};
for (const envFile of envFiles) {
  const resolved = path.resolve(envFile);
  if (!fs.existsSync(resolved)) continue;
  Object.assign(values, parseDotenv(fs.readFileSync(resolved, 'utf8')));
  loadedFileCount += 1;
}

if (envFiles.length > 0 && loadedFileCount === 0) {
  fail(`None of the configured env files exist: ${envFiles.join(', ')}`);
}

// Existing process variables have the same highest priority Vite gives them.
for (const key of [...REQUIRED_KEYS, ...CONTROL_KEYS]) {
  if (process.env[key] !== undefined) values[key] = process.env[key];
}

const missing = REQUIRED_KEYS.filter((key) => {
  const value = values[key]?.trim();
  return !value || /REPLACE_ME|your-/iu.test(value);
});
if (missing.length > 0) {
  fail(`${label} is missing real values for: ${missing.join(', ')}`);
}

if (values.VITE_FIREBASE_PROJECT_ID !== expectedProject) {
  fail(
    `${label} must use Firebase project "${expectedProject}", not "${values.VITE_FIREBASE_PROJECT_ID}".`,
  );
}

const expectedAuthDomain = `${expectedProject}.firebaseapp.com`;
if (values.VITE_FIREBASE_AUTH_DOMAIN !== expectedAuthDomain) {
  fail(
    `${label} must use auth domain "${expectedAuthDomain}", not "${values.VITE_FIREBASE_AUTH_DOMAIN}".`,
  );
}

const allowedStorageBuckets = new Set([
  `${expectedProject}.firebasestorage.app`,
  `${expectedProject}.appspot.com`,
]);
if (!allowedStorageBuckets.has(values.VITE_FIREBASE_STORAGE_BUCKET)) {
  fail(`${label} storage bucket does not belong to project "${expectedProject}".`);
}

if (values.VITE_USE_EMULATOR === 'true') {
  fail(`${label} cannot be built with VITE_USE_EMULATOR=true.`);
}

console.log(`[deploy-env] ${label} environment is valid for project "${expectedProject}".`);
