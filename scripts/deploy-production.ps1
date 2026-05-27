# Deploy to Firebase Hosting PRODUCTION
#
# Usage:
#   .\scripts\deploy-production.ps1            # build:production + firebase deploy --only hosting
#   .\scripts\deploy-production.ps1 -Check     # run type-check + lint + unit tests first
#   .\scripts\deploy-production.ps1 -Yes       # skip the interactive confirmation prompt
#
# Pushes to the live site URL: https://nerilo.web.app
# This is destructive — every visitor sees the new build immediately.
# Prefer ./scripts/deploy-staging.ps1 for any change you have not validated.

param(
    [switch]$Check,
    [switch]$Yes
)

$ErrorActionPreference = "Stop"
$ProjectRoot = Split-Path -Parent $PSScriptRoot
if (-not (Test-Path (Join-Path $ProjectRoot "package.json"))) {
    Write-Error "Could not locate project root (package.json missing)."
    exit 1
}
Set-Location $ProjectRoot
Write-Host "[deploy-production] Project root: $ProjectRoot" -ForegroundColor Cyan

if (-not (Test-Path (Join-Path $ProjectRoot ".env.production")) -and
    -not (Test-Path (Join-Path $ProjectRoot ".env.local"))) {
    Write-Error ".env.production (or .env.local) not found — refusing to build production without Firebase config."
    exit 1
}

if (-not $Yes) {
    Write-Host ""
    Write-Host "  About to deploy to PRODUCTION (https://nerilo.web.app)." -ForegroundColor Yellow
    Write-Host "  This is live — every user sees the new build immediately." -ForegroundColor Yellow
    $reply = Read-Host "  Type 'deploy' to continue, anything else to abort"
    if ($reply -ne "deploy") {
        Write-Host "[deploy-production] Aborted." -ForegroundColor Red
        exit 1
    }
}

if ($Check) {
    Write-Host "[deploy-production] Running pre-deploy checks..." -ForegroundColor Yellow
    & npm run type-check;  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
    & npm run lint;        if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
    & npm run test:run;    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
    Write-Host "[deploy-production] Checks passed." -ForegroundColor Green
}

Write-Host "[deploy-production] Building (mode=production)..." -ForegroundColor Yellow
& npm run build:production
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

Write-Host "[deploy-production] Deploying to Firebase Hosting (live)..." -ForegroundColor Yellow
& firebase deploy --only hosting --project production
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

Write-Host "[deploy-production] Deploy complete." -ForegroundColor Green
exit 0
