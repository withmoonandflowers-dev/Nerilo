# 安全上板：先執行檢查再部署 Hosting（等同 deploy.ps1 -Check）
# 使用方式：.\scripts\deploy-safe.ps1

& (Join-Path $PSScriptRoot "deploy.ps1") -Check
exit $LASTEXITCODE
