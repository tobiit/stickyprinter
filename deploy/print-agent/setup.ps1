# One-time setup for the StickyPrinter local print agent on Windows.
#
# Prerequisites (install manually first, both add themselves to PATH by
# default during install):
#   - Python 3.11+  https://www.python.org/downloads/windows/
#   - Git for Windows  https://git-scm.com/download/win
#
# Usage: right-click setup.bat -> Run, or from a PowerShell prompt:
#   .\setup.ps1

$ErrorActionPreference = "Stop"
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $ScriptDir

$VendorDir = Join-Path $ScriptDir "vendor\TiMini-Print"
$VenvDir = Join-Path $ScriptDir "venv"

function Assert-Command($name, $installHint) {
    $cmd = Get-Command $name -ErrorAction SilentlyContinue
    if (-not $cmd) {
        Write-Error "$name not found on PATH. $installHint"
        exit 1
    }
}

Write-Host "==> Checking prerequisites"
Assert-Command "python" "Install it from https://www.python.org/downloads/windows/ (check 'Add python.exe to PATH'), then re-run this script."
Assert-Command "git" "Install Git for Windows from https://git-scm.com/download/win, then re-run this script."
python --version

if (-not (Test-Path $VenvDir)) {
    Write-Host "==> Creating virtual environment"
    python -m venv $VenvDir
} else {
    Write-Host "==> Virtual environment already exists, skipping"
}

if (-not (Test-Path $VendorDir)) {
    Write-Host "==> Fetching TiMiniPrint library (Apache-2.0, github.com/Dejniel/TiMini-Print)"
    New-Item -ItemType Directory -Force -Path (Join-Path $ScriptDir "vendor") | Out-Null
    git clone --depth 1 https://github.com/Dejniel/TiMini-Print.git $VendorDir
} else {
    Write-Host "==> TiMiniPrint library already present at $VendorDir, skipping"
    Write-Host "    (delete that folder and re-run this script to update it)"
}

Write-Host "==> Installing Python dependencies"
& "$VenvDir\Scripts\pip.exe" install --upgrade pip
& "$VenvDir\Scripts\pip.exe" install -r "$ScriptDir\requirements.txt"

if (-not (Test-Path "$ScriptDir\config.json")) {
    Copy-Item "$ScriptDir\config.example.json" "$ScriptDir\config.json"
    Write-Host ""
    Write-Host "==> Created config.json - edit it (server URL, moderator login, workshop code(s)) before running the agent." -ForegroundColor Yellow
} else {
    Write-Host "==> config.json already exists, leaving it untouched"
}

Write-Host ""
Write-Host "Setup complete. Power on the C17 (no Windows pairing needed), edit config.json, then run: .\run-agent.bat" -ForegroundColor Green
