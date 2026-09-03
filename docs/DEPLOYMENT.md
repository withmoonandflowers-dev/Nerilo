# Deployment

Nerilo has two independently deployable web apps. The React app remains the
production site; the Nuxt/Vue candidate can only be published to an isolated
Firebase preview channel until the ADR-0017 production cutover gates are met.
The Netlify webhook is deployed separately from `netlify.toml`; Firebase Cloud
Functions are built in CI but intentionally excluded from every normal deploy.

## Deployment ownership

| Component | Build output | Deployment path | Production status |
|---|---|---|---|
| React app | `dist/` | `firebase-deploy.yml` or React npm scripts | Live at `https://nerilo.web.app` |
| Nuxt/Vue candidate | `web-vue/.output/public/` | Manual `web-vue-preview.yml` or `npm run deploy:web-vue:preview` | Preview only; never replaces React |
| Netlify webhook | `netlify/functions/` | Netlify Git integration from `netlify.toml` | Separate service at `nerilo-api.netlify.app` |
| Firebase Functions | `functions/lib/` | Explicit guarded full deploy only | Not deployed; Blaze/runtime review pending |
| MCP runtime | `dist-mcp/` | Local stdio process | No remote deployment |

## Quick reference

| What | Staging | Production |
|---|---|---|
| URL | `https://nerilo-staging--staging-<hash>.web.app` | `https://nerilo.web.app` |
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
   `.env.staging` and `.env.production` are gitignored, never commit real credentials.
3. **Firebase project aliases** are set in `.firebaserc`:
   ```json
   { "default": "nerilo", "production": "nerilo", "staging": "nerilo-staging" }
   ```
   `production` points at the live Firebase project; `staging` points at a **separate** project (`nerilo-staging`) so beta users hit an isolated Auth + Firestore backend. Confirm that project exists and has the required services before the first preview deploy; see "First-time staging project setup" below.

## First-time staging project setup

The `nerilo-staging` Firebase project must exist before `npm run deploy:staging`
can succeed. Provision the shared environment once; each developer only needs
an authorized Firebase CLI session and a local env file:

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
8. Run `npm run deploy:staging`. Both the npm command and platform wrappers refuse to run while required values are missing, contain `REPLACE_ME_`, or point at any project other than `nerilo-staging`.

## Deploy to staging

```bash
# fastest: no pre-checks
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
# fastest: no pre-checks, no confirmation
npm run deploy:production

# with type-check + lint + unit tests first
npm run deploy:production:safe

# Windows PowerShell wrapper: also prompts for confirmation before deploying
.\scripts\deploy-production.ps1
.\scripts\deploy-production.ps1 -Check
.\scripts\deploy-production.ps1 -Yes        # skip the confirmation prompt
```

The PowerShell wrapper requires you to type `deploy` at the confirmation prompt unless `-Yes` is passed. The npm script is non-interactive but still validates all six Firebase values and requires project ID `nerilo`.

## CI deploy

`.github/workflows/firebase-deploy.yml` runs on pushes to `master` and manual dispatch. It uses Node 24, Java 21 and the `FIREBASE_SERVICE_ACCOUNT_NERILO` service-account JSON secret. A production deploy only runs after:

1. type-check, lint and unit tests;
2. Firestore rules integration tests;
3. the emulator-backed P0 browser path;
4. the React production build and Functions build.

The deploy scope is explicitly `hosting,firestore:rules,firestore:indexes`.
Functions are compiled as a regression gate but are not deployed.

## Nuxt/Vue candidate preview

The candidate has a separate Hosting config (`firebase.web-vue-preview.json`)
and fixed preview channel (`vue-candidate`). It always uses the
`nerilo-staging` Firebase project and cannot replace the React live channel.

### GitHub Actions

Create a protected GitHub environment named `vue-preview`, add the following
environment secrets, then manually run **Deploy Vue Preview**:

```text
FIREBASE_SERVICE_ACCOUNT_NERILO_STAGING
VUE_PREVIEW_FIREBASE_API_KEY
VUE_PREVIEW_FIREBASE_AUTH_DOMAIN
VUE_PREVIEW_FIREBASE_PROJECT_ID       # must equal nerilo-staging
VUE_PREVIEW_FIREBASE_STORAGE_BUCKET
VUE_PREVIEW_FIREBASE_MESSAGING_SENDER_ID
VUE_PREVIEW_FIREBASE_APP_ID
```

Optional preview-only secrets are `VUE_PREVIEW_LS_CHECKOUT_URL`,
`VUE_PREVIEW_APPCHECK_KEY` and `VUE_PREVIEW_SENTRY_DSN`. TURN credentials reuse
the existing `VITE_TURN_*` secrets. Do not use the production Lemon Squeezy
checkout URL in preview.

The workflow validates the web config and service-account `project_id`, runs
Nuxt type-check/static generation, saves the exact output for 14 days, and only
then publishes the preview channel. Choose a 1, 7 or 30-day expiry at dispatch.

### Local preview deploy

```bash
cp web-vue/.env.preview.example web-vue/.env.preview
# Fill values from nerilo-staging, then authenticate Firebase CLI.
npm run deploy:web-vue:preview
```

The local command performs the same project-ID guard, type-check and static
generation before deploying a seven-day preview.

Run the three release smoke paths against the URL printed by Firebase. The
smoke config rejects the production Firebase hosts and any non-staging channel:

```bash
VUE_SMOKE_BASE_URL=https://nerilo-staging--vue-candidate-<hash>.web.app \
  npm run smoke:vue-preview
```

All three paths are hard requirements: direct encrypted messaging, a selected
TURN `relay` candidate, and an honest non-encrypted state when WebRTC is
disabled. A TURN failure is a deployment/configuration blocker; do not weaken
the assertion or promote the candidate.

Delete the candidate channel without touching React production:

```bash
firebase hosting:channel:delete vue-candidate --project staging
```

## Promoting staging to production

There is no automatic promotion, preview channels are not "promotable" in Firebase. The intended workflow is:

1. Deploy to staging, share the URL with reviewers.
2. Once approved, run `npm run deploy:production:safe` from the same commit.

Production rebuilds the approved commit with production environment values. It
is intentionally not byte-identical to staging because Firebase and optional
integration settings are embedded at build time.

The Vue candidate is not covered by this promotion process. Replacing React
with Vue remains a separate ADR-0017 cutover and requires all recorded parity,
smoke, visual approval and rollback gates.

## Guarded full deploy

Normal root deploy commands never publish Firebase Functions. `npm run deploy:full`
now exits before build unless the operator explicitly acknowledges the first
Functions deployment and possible Blaze billing:

```bash
npm run deploy:full -- --confirm-functions-and-billing
```

Do not use that override until the Node runtime/dependencies, Twilio config,
secrets, region, Cloud Build API and billing budget have been reviewed. The
command deploys exactly Hosting, Firestore rules/indexes and Functions to the
`production` alias; it is not used by CI.

## Rollback

Firebase Hosting keeps prior versions. To roll back production:

```bash
firebase hosting:rollback --project production
```

Or use the [Firebase Console → Hosting → Release history → Rollback](https://console.firebase.google.com/), pick a prior release and click "Rollback".

Staging channels can be deleted with:

```bash
firebase hosting:channel:delete staging --project staging
```

## Running E2E tests locally

`firebase-tools` is now a `devDependency`, so emulators are available after `npm install`. Three ways to run:

```bash
# Full Playwright suite with emulators auto-booted (one shot)
npm run test:e2e:release

# Stable subset only (matches what CI runs as a merge gate)
npm run test:e2e:stable

# Manual: start emulators yourself, leave them running, then run Playwright
npx firebase emulators:start --only auth,firestore --project nerilo
npm run test:e2e          # in another terminal
```

`test:e2e:release`, `test:e2e:stable`, and the legacy diagnostic command `test:e2e:ci` use `firebase emulators:exec`, which boots Auth (9099) + Firestore (8080), runs Playwright, and tears down the emulators on exit.

Requirements:
- **Java 21** (`firebase-tools` 15+ emulator baseline). On macOS: `brew install temurin@21`. On Linux: install a JDK 21 package. On Windows: install Temurin 21 from adoptium.net.
- First emulator run downloads ~150 MB of JARs into `~/.cache/firebase/emulators/`. CI caches this between runs.

## Sentry error reporting

When `VITE_SENTRY_DSN` is set in `.env.staging` or `.env.production`, the app reports unhandled errors and React rendering failures to Sentry. To enable:

1. Create a project at [sentry.io](https://sentry.io) (platform: React).
2. Copy the DSN into the env file: `VITE_SENTRY_DSN=https://...@sentry.io/...`.
3. Re-deploy.

Locally and on `localhost` the integration is silently disabled (`beforeSend` filter) so dev errors never reach Sentry even if a DSN leaks into `.env.local`.
