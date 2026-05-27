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
3. **Firebase project aliases** are set in `.firebaserc`:
   ```json
   { "default": "nerilo", "production": "nerilo", "staging": "nerilo-staging" }
   ```
   `production` points at the live Firebase project; `staging` points at a **separate** project (`nerilo-staging`) so beta users hit an isolated Auth + Firestore backend. The staging project still needs to be created — see "First-time staging project setup" below.

## First-time staging project setup

The `nerilo-staging` Firebase project must be created in the Firebase Console before `npm run deploy:staging` can succeed. Do this once per developer / per environment:

1. Open [console.firebase.google.com](https://console.firebase.google.com), click **Add project**, name it `nerilo-staging`. Disable Analytics (not needed for staging).
2. Once the project is provisioned, click **Add app → Web** (`</>`), register the app as "Nerilo staging", and copy the 6 config values shown.
3. **Enable Anonymous auth**: Build → Authentication → Sign-in method → Anonymous → Enable. The Nerilo app falls back to anonymous auth for guest users; without this, the first page load fails.
4. **Enable Cloud Firestore**: Build → Firestore Database → Create database → Production mode → pick a region (e.g. `asia-east1`).
5. **Deploy Firestore rules** to the staging project so they match production:
   ```bash
   firebase deploy --only firestore:rules --project staging
   ```
6. Copy [.env.staging.example](../.env.staging.example) to `.env.staging` and paste the 6 `VITE_FIREBASE_*` values from step 2.
7. (Optional) Create a Sentry project and paste the DSN into `VITE_SENTRY_DSN` if you want crash reports from staging.
8. Run `npm run deploy:staging`. The deploy script refuses to run while any `REPLACE_ME_` placeholders remain.

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
