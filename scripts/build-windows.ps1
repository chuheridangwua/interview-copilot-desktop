$ErrorActionPreference = "Stop"

function Test-Command($Name) {
  return [bool](Get-Command $Name -ErrorAction SilentlyContinue)
}

Write-Host "Interview Copilot Windows build" -ForegroundColor Cyan

if (-not $IsWindows) {
  throw "这个脚本必须在 Windows PowerShell 里运行。"
}

if (-not (Test-Command "node")) {
  throw "未检测到 Node.js。请先安装 Node.js LTS，然后重新打开 PowerShell。"
}

if (-not (Test-Command "npm")) {
  throw "未检测到 npm。请确认 Node.js 安装完整。"
}

if (-not (Test-Command "rustc") -or -not (Test-Command "cargo")) {
  throw "未检测到 Rust/Cargo。请先安装 Rust：https://rustup.rs/，并选择 MSVC toolchain。"
}

Write-Host "Node: $(node -v)" -ForegroundColor DarkGray
Write-Host "npm:  $(npm -v)" -ForegroundColor DarkGray
Write-Host "Rust: $(rustc --version)" -ForegroundColor DarkGray
Write-Host "Cargo: $(cargo --version)" -ForegroundColor DarkGray

Write-Host "`nInstalling dependencies..." -ForegroundColor Cyan
npm install

Write-Host "`nRunning matcher tests..." -ForegroundColor Cyan
npm run test:matcher

Write-Host "`nBuilding frontend..." -ForegroundColor Cyan
npm run build

Write-Host "`nBuilding Windows desktop installer..." -ForegroundColor Cyan
npm run client:build

$artifactRoots = @(
  "src-tauri\target\release\bundle\msi",
  "src-tauri\target\release\bundle\nsis",
  "src-tauri\target\release"
)

Write-Host "`nBuild finished. Possible artifacts:" -ForegroundColor Green
foreach ($root in $artifactRoots) {
  if (Test-Path $root) {
    Get-ChildItem $root -File -Include *.msi, *.exe -Recurse | ForEach-Object {
      Write-Host "  $($_.FullName)" -ForegroundColor Green
    }
  }
}

