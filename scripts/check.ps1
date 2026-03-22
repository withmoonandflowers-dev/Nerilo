# Quality gate: type-check + unit tests (ci:fast). For full CI including lint use: npm run ci

$ErrorActionPreference = "Stop"
$ProjectRoot = Split-Path -Parent $PSScriptRoot
if (-not (Test-Path (Join-Path $ProjectRoot "package.json"))) {
    $ProjectRoot = $PSScriptRoot
    while ($ProjectRoot) {
        if (Test-Path (Join-Path $ProjectRoot "package.json")) { break }
        $ProjectRoot = Split-Path -Parent $ProjectRoot
    }
}
if (-not $ProjectRoot -or -not (Test-Path (Join-Path $ProjectRoot "package.json"))) {
    Write-Error "Project root (with package.json) not found."
    exit 1
}

Set-Location $ProjectRoot
Write-Host "[check] Project root: $ProjectRoot" -ForegroundColor Cyan
Write-Host "[check] Running type-check and unit tests..." -ForegroundColor Yellow

& npm run ci:fast
if ($LASTEXITCODE -ne 0) {
    Write-Host "[check] Failed. Fix before push/PR." -ForegroundColor Red
    exit $LASTEXITCODE
}

Write-Host "[check] Passed." -ForegroundColor Green
exit 0
