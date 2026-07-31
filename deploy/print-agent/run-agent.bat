@echo off
REM Double-click entry point for run-agent.ps1 - bypasses PowerShell's
REM default script-execution policy so this runs without extra configuration.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0run-agent.ps1"
pause
