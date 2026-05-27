# Deploy to Firebase Hosting STAGING (preview channel)
#
# Usage:
#   .\scripts\deploy-staging.ps1            # build:staging + hosting:channel:deploy staging
#   .\scripts\deploy-staging.ps1 -Check     # run type-check + lint + unit tests first
#   .\scripts\deploy-staging.ps1 -Expires "7d"   # override default 30d channel expiry
#
# The staging preview channel publishes to a URL of the form:
#   https://nerilo--staging-<hash>.web.app
# It shares the same Firebase backend as production (Auth + Firestore), but the
# served bundle is built from .env.staging so the front-end can differ.

param(
    [switch]$Check,
    [string]$Expires = "30d"
)

$ErrorActionPreference = "Stop"
$ProjectRoot = Split-Path -Parent $PSScriptRoot
if (-not (Test-Path (Join-Path $ProjectRoot "package.json"))) {
    Write-Error "Could not locate project root (package.json missing)."
    exit 1
}
Set-Location $ProjectRoot
Write-Host "[deploy-staging] Project root: $ProjectRoot" -ForegroundColor Cyan

if (-not (Test-Path (Join-Path $ProjectRoot ".env.staging"))) {
    Write-Warning ".env.staging not found — Vite will fall back to .env / .env.local."
    Write-Warning "Copy .env.staging.example to .env.staging and populate it for an isolated staging config."
}

if ($Check) {
    Write-Host "[deploy-staging] Running pre-deploy checks (type-check, lint, unit tests)..." -ForegroundColor Yellow
    & npm run type-check;  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
    & npm run lint;        if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
    & npm run test:run;    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
    Write-Host "[deploy-staging] Checks passed." -ForegroundColor Green
}

Write-Host "[deploy-staging] Building (mode=staging)..." -ForegroundColor Yellow
& npm run build:staging
if ($LASTEXITCODE -ne 0) { Write-Error "Build failed"; exit $LASTEXITCODE }

Write-Host "[deploy-staging] Deploying to Firebase Hosting preview channel 'staging' (expires=$Expires)..." -ForegroundColor Yellow
& firebase hosting:channel:deploy staging --project staging --expires $Expires
if ($LASTEXITCODE -ne 0) { Write-Error "Deploy failed"; exit $LASTEXITCODE }

Write-Host "[deploy-staging] Done. Preview URL printed above." -ForegroundColor Green
exit 0
