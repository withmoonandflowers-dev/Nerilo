# E2E 完整套件（含 comprehensive、architecture、mesh）
# 使用方式：在專案根目錄執行 .\scripts\test-e2e-full.ps1

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
    Write-Error "找不到專案根目錄（含 package.json）"
    exit 1
}

Set-Location $ProjectRoot
Write-Host "[test-e2e-full] 專案根目錄: $ProjectRoot"
Write-Host "[test-e2e-full] 執行 E2E 完整套件（comprehensive-chat, architecture-selection, mesh-gossip）..."

$specs = @(
    "tests/e2e/comprehensive-chat.spec.ts",
    "tests/e2e/architecture-selection.spec.ts",
    "tests/e2e/mesh-gossip.spec.ts"
)
$args = @("run", "test:e2e", "--") + $specs + @("--timeout=120000")
& npm @args
exit $LASTEXITCODE
