# Deployment

Nerilo deploys to Firebase Hosting. There are two targets — **staging** and **production** — built from separate Vite modes (`--mode staging` vs `--mode production`) and deployed via separate `npm` scripts. Staging uses a Firebase Hosting **preview channel** so it lives at its own URL without touching the live site.

## Quick reference

| What | Staging | Production |
|---|---|---|
| URL | `https://nerilo--staging-<hash>.web.app` | `https://nerilo.web.app` |
| Env file | `.env.staging` | `.env.production` (or `.env.local`) |
| Vite mode | `staging` | `production` |
| Build script | `npm run build:staging` | `npm run build:production` |
| Deploy script | `npm run deploy:staging` | `npm run deploy:production` |
| Safe variant | `npm run deploy:staging:safe` | `npm run deploy:production:safe` |
| Firebase project alias | `staging` | `production` |
| Channel | Preview channel `staging`, 30-day TTL | Live site |

`*:safe` variants run `type-check + lint + test:run` before building.

## Prerequisites

1. **Firebase CLI** installed and authenticated:
   ```bash
   npm install -g firebase-tools
   firebase login
   ```
2. **Env files** populated:
   ```bash
   cp .env.staging.example     .env.staging
   cp .env.production.example  .env.production
   # fill in the VITE_FIREBASE_* values for each
   ```
   `.env.staging` and `.env.production` are gitignored — never commit real credentials.
3. **Firebase project aliases** are already set in `.firebaserc`:
   ```json
   { "default": "nerilo", "production": "nerilo", "staging": "nerilo" }
   ```
   Today both aliases point at the same Firebase project (`nerilo`); the isolation comes from the preview channel. When a separate `nerilo-staging` Firebase project is provisioned, swap the `staging` alias value and update `.env.staging` to point at it.

## Deploy to staging

```bash
# fastest — no pre-checks
npm run deploy:staging

# with type-check + lint + unit tests first (recommended before sharing the URL)
npm run deploy:staging:safe

# Windows PowerShell wrapper (same flags as the npm scripts)
.\scripts\deploy-staging.ps1
.\scripts\deploy-staging.ps1 -Check
.\scripts\deploy-staging.ps1 -Expires 7d   # default is 30d

# POSIX wrapper
./scripts/deploy-staging.sh
./scripts/deploy-staging.sh --check
./scripts/deploy-staging.sh --expires 7d
```

The Firebase CLI prints the preview URL at the end of the deploy. Channels auto-expire after 30 days unless re-deployed.

## Deploy to production

```bash
# fastest — no pre-checks, no confirmation
npm run deploy:production

# with type-check + lint + unit tests first
npm run deploy:production:safe

# Windows PowerShell wrapper — also prompts for confirmation before deploying
.\scripts\deploy-production.ps1
.\scripts\deploy-production.ps1 -Check
.\scripts\deploy-production.ps1 -Yes        # skip the confirmation prompt
```

The PowerShell wrapper requires you to type `deploy` at the confirmation prompt unless `-Yes` is passed. Use the npm script when you want a non-interactive deploy (e.g. from CI).

## CI deploy

`.github/workflows/ci.yml` has a `deploy` job that runs on pushes to `master` after `quality` and `e2e` succeed. It currently uses `npm run build` + `firebase deploy --only hosting` and pushes to **production**. To wire CI to staging instead, replace those two steps with `npm run deploy:staging` and provide the `FIREBASE_TOKEN` secret.

## Promoting staging to production

There is no automatic promotion — preview channels are not "promotable" in Firebase. The intended workflow is:

1. Deploy to staging, share the URL with reviewers.
2. Once approved, run `npm run deploy:production:safe` from the same commit.

The build is deterministic for a given commit + env file, so the same artifact lands in production.

## Rollback

Firebase Hosting keeps prior versions. To roll back production:

```bash
firebase hosting:rollback --project production
```

Or use the [Firebase Console → Hosting → Release history → Rollback](https://console.firebase.google.com/) — pick a prior release and click "Rollback".

Staging channels can be deleted with:

```bash
firebase hosting:channel:delete staging --project staging
```

## Local emulator note

Vite `--mode test` connects to the local Firebase emulators (Auth 9099, Firestore 8080) — see [src/config/firebase.ts](../src/config/firebase.ts). The emulator suite requires `firebase-tools` installed locally; install it and run `firebase emulators:start` before `npm run test:e2e`.
