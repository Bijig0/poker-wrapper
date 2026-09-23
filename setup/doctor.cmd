@echo off
rem Double-click: checks every piece of the Poker Wrapper and says what to fix. Changes nothing.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0doctor.ps1" %*
echo.
pause
