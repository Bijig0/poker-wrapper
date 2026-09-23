@echo off
rem Opens the GTO Wizard window the Poker Wrapper reads from, in front, so you can sign in (again).
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0..\scripts\start_gtow_chrome.ps1" -Force -Foreground
echo.
echo Sign in to GTO Wizard in the Chrome window that opened, then leave it open (minimise is fine).
pause
