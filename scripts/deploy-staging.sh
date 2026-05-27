#!/usr/bin/env bash
# Deploy to Firebase Hosting STAGING (preview channel)
#
# Usage:
#   ./scripts/deploy-staging.sh                    # build:staging + hosting:channel:deploy staging
#   ./scripts/deploy-staging.sh --check            # run type-check + lint + unit tests first
#   ./scripts/deploy-staging.sh --expires 7d       # override default 30d channel expiry
#
# Publishes to https://nerilo-staging--staging-<hash>.web.app via the
# nerilo-staging Firebase project (separate from production).
# Requires .env.staging with real values — the script refuses to run if any
# REPLACE_ME_ placeholders remain.

set -euo pipefail

CHECK=0
EXPIRES="30d"
while [[ $# -gt 0 ]]; do
  case "$1" in
    --check)   CHECK=1; shift ;;
    --expires) EXPIRES="$2"; shift 2 ;;
    *) echo "Unknown option: $1"; exit 2 ;;
  esac
done

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$PROJECT_ROOT"
echo "[deploy-staging] Project root: $PROJECT_ROOT"

# ── Guard: .env.staging must exist ─────────────────────────────────────────
if [[ ! -f .env.staging ]]; then
  echo "" >&2
  echo "  .env.staging not found." >&2
  echo "  Run:  cp .env.staging.example .env.staging" >&2
  echo "  Then fill in the 6 VITE_FIREBASE_* values from the" >&2
  echo "  nerilo-staging Firebase project console." >&2
  echo "  See docs/DEPLOYMENT.md for the full setup checklist." >&2
  exit 1
fi

# ── Guard: no REPLACE_ME_ placeholders in non-comment lines ───────────────
if grep -E "^[^#].*REPLACE_ME_" .env.staging > /dev/null 2>&1; then
  echo "" >&2
  echo "  .env.staging still has REPLACE_ME_ placeholders:" >&2
  grep -nE "^[^#].*REPLACE_ME_" .env.staging >&2 || true
  echo "" >&2
  echo "  Fill in the real values from your Firebase project console" >&2
  echo "  (Project settings → General → Your apps → Web app config)." >&2
  exit 1
fi

if [[ "$CHECK" -eq 1 ]]; then
  echo "[deploy-staging] Running pre-deploy checks..."
  npm run type-check
  npm run lint
  npm run test:run
  echo "[deploy-staging] Checks passed."
fi

echo "[deploy-staging] Building (mode=staging)..."
npm run build:staging

echo "[deploy-staging] Deploying to Firebase Hosting preview channel 'staging' on project 'nerilo-staging' (expires=$EXPIRES)..."
firebase hosting:channel:deploy staging --project staging --expires "$EXPIRES"

echo "[deploy-staging] Done. Preview URL printed above."
