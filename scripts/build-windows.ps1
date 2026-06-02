$ErrorActionPreference = "Stop"

function Test-Command($Name) {
  return [bool](Get-Command $Name -ErrorAction SilentlyContinue)
}

Write-Host "Interview Copilot Electron Windows build" -ForegroundColor Cyan

if (-not $IsWindows) {
  throw "这个脚本必须在 Windows PowerShell 里运行。"
}

if (-not (Test-Command "node")) {
  throw "未检测到 Node.js。请先安装 Node.js 22 或 LTS 版本，然后重新打开 PowerShell。"
}

if (-not (Test-Command "npm")) {
  throw "未检测到 npm。请确认 Node.js 安装完整。"
}

Write-Host "Node: $(node -v)" -ForegroundColor DarkGray
Write-Host "npm:  $(npm -v)" -ForegroundColor DarkGray

Write-Host "`nInstalling dependencies..." -ForegroundColor Cyan
npm install

Write-Host "`nRunning matcher tests..." -ForegroundColor Cyan
npm run test:matcher

Write-Host "`nBuilding Windows Electron installer..." -ForegroundColor Cyan
npm run client:build

Write-Host "`nBuild finished. Possible artifacts:" -ForegroundColor Green
if (Test-Path "release") {
  Get-ChildItem "release" -File -Include *.msi, *.exe -Recurse | ForEach-Object {
    Write-Host "  $($_.FullName)" -ForegroundColor Green
  }
}
