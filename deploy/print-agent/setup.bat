@echo off
REM Double-click entry point for setup.ps1 - bypasses PowerShell's default
REM script-execution policy so this runs without extra configuration.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0setup.ps1"
pause
