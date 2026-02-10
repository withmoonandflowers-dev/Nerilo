# E2E 快速回歸（不含 Mesh，含 2 人連線測試）
# 使用方式：在專案根目錄執行 .\scripts\test-e2e-quick.ps1

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
Write-Host "[test-e2e-quick] 專案根目錄: $ProjectRoot"
Write-Host "[test-e2e-quick] 執行 E2E 快速回歸（waiting-room, room-management, user-chat, single-user-room, room-closed, room-timeout, guest-chat）..."

$specs = @(
    "tests/e2e/waiting-room.spec.ts",
    "tests/e2e/room-management.spec.ts",
    "tests/e2e/user-chat.spec.ts",
    "tests/e2e/single-user-room.spec.ts",
    "tests/e2e/room-closed.spec.ts",
    "tests/e2e/room-timeout.spec.ts",
    "tests/e2e/guest-chat.spec.ts"
)
$args = @("run", "test:e2e", "--") + $specs + @("--timeout=60000")
& npm @args
exit $LASTEXITCODE
