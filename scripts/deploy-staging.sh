#!/usr/bin/env bash
# Deploy to Firebase Hosting STAGING (preview channel)
#
# Usage:
#   ./scripts/deploy-staging.sh                    # build:staging + hosting:channel:deploy staging
#   ./scripts/deploy-staging.sh --check            # run type-check + lint + unit tests first
#   ./scripts/deploy-staging.sh --expires 7d       # override default 30d channel expiry
#
# Publishes to a URL of the form https://nerilo--staging-<hash>.web.app.
# Shares the production Firebase backend; bundle is built from .env.staging.

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

if [[ ! -f .env.staging ]]; then
  echo "[deploy-staging] WARNING: .env.staging not found — Vite will fall back to .env / .env.local." >&2
  echo "[deploy-staging] Copy .env.staging.example to .env.staging for an isolated staging config." >&2
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

echo "[deploy-staging] Deploying to Firebase Hosting preview channel 'staging' (expires=$EXPIRES)..."
firebase hosting:channel:deploy staging --project staging --expires "$EXPIRES"

echo "[deploy-staging] Done. Preview URL printed above."
