import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const CONFIRMATION = '--confirm-functions-and-billing';
const projectRoot = fileURLToPath(new URL('..', import.meta.url));

if (process.argv.length !== 3 || process.argv[2] !== CONFIRMATION) {
  console.error(`
[deploy-full] Blocked before build or deploy.

This command includes the first production Cloud Functions deployment and may
enable billable Google Cloud services. The normal production workflow deploys
Hosting + Firestore only.

After reviewing the Functions runtime, secrets and Blaze budget, run:
  npm run deploy:full -- ${CONFIRMATION}
`);
  process.exit(1);
}

const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const npxCommand = process.platform === 'win32' ? 'npx.cmd' : 'npx';

function run(command, args) {
  const result = spawnSync(command, args, {
    cwd: projectRoot,
    stdio: 'inherit',
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

run(process.execPath, [
  'scripts/validate-firebase-web-env.mjs',
  '--from',
  '.env.local',
  '--from',
  '.env.production',
  '--project',
  'nerilo',
  '--label',
  'full production deploy',
]);
run(npmCommand, ['run', 'build:production']);
run(npxCommand, [
  'firebase-tools',
  'deploy',
  '--only',
  'hosting,firestore:rules,firestore:indexes,functions',
  '--project',
  'production',
]);
