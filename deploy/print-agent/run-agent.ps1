# Runs the StickyPrinter print agent using the virtual environment created
# by setup.ps1. Leave this console window open while it's watching for
# print jobs; Ctrl+C to stop.

$ErrorActionPreference = "Stop"
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $ScriptDir

$PythonExe = Join-Path $ScriptDir "venv\Scripts\python.exe"
if (-not (Test-Path $PythonExe)) {
    Write-Error "venv not found — run setup.ps1 (or setup.bat) first."
    exit 1
}
if (-not (Test-Path (Join-Path $ScriptDir "config.json"))) {
    Write-Error "config.json not found — run setup.ps1 first, then edit config.json."
    exit 1
}

& $PythonExe "$ScriptDir\agent.py"
