@echo off
rem Double-click to set up (or repair) the Poker Wrapper on this laptop. Safe to run again.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0setup.ps1" %*
echo.
pause
