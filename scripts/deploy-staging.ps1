# Deploy to Firebase Hosting STAGING (preview channel)
#
# Usage:
#   .\scripts\deploy-staging.ps1            # build:staging + hosting:channel:deploy staging
#   .\scripts\deploy-staging.ps1 -Check     # run type-check + lint + unit tests first
#   .\scripts\deploy-staging.ps1 -Expires "7d"   # override default 30d channel expiry
#
# Publishes to https://nerilo-staging--staging-<hash>.web.app via the
# nerilo-staging Firebase project (separate from production).
# Requires .env.staging with real values — the script refuses to run if any
# REPLACE_ME_ placeholders remain.

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

# ── Guard: .env.staging must exist ────────────────────────────────────────
$EnvFile = Join-Path $ProjectRoot ".env.staging"
if (-not (Test-Path $EnvFile)) {
    Write-Host ""
    Write-Host "  .env.staging not found." -ForegroundColor Red
    Write-Host "  Run:  Copy-Item .env.staging.example .env.staging" -ForegroundColor Yellow
    Write-Host "  Then fill in the 6 VITE_FIREBASE_* values from the" -ForegroundColor Yellow
    Write-Host "  nerilo-staging Firebase project console." -ForegroundColor Yellow
    Write-Host "  See docs/DEPLOYMENT.md for the full setup checklist." -ForegroundColor Yellow
    exit 1
}

# ── Guard: no REPLACE_ME_ placeholders in non-comment lines ───────────────
$Placeholders = Select-String -Path $EnvFile -Pattern "^[^#].*REPLACE_ME_"
if ($Placeholders) {
    Write-Host ""
    Write-Host "  .env.staging still has REPLACE_ME_ placeholders:" -ForegroundColor Red
    foreach ($p in $Placeholders) {
        Write-Host "    line $($p.LineNumber): $($p.Line)" -ForegroundColor Yellow
    }
    Write-Host ""
    Write-Host "  Fill in the real values from your Firebase project console" -ForegroundColor Yellow
    Write-Host "  (Project settings → General → Your apps → Web app config)." -ForegroundColor Yellow
    exit 1
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

Write-Host "[deploy-staging] Deploying to Firebase Hosting preview channel 'staging' on project 'nerilo-staging' (expires=$Expires)..." -ForegroundColor Yellow
& firebase hosting:channel:deploy staging --project staging --expires $Expires
if ($LASTEXITCODE -ne 0) { Write-Error "Deploy failed"; exit $LASTEXITCODE }

Write-Host "[deploy-staging] Done. Preview URL printed above." -ForegroundColor Green
exit 0
