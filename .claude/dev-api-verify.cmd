@echo off
rem A second gto-trainer API on :2001 for checking dashboard edits without restarting the live :2000 one.
rem It runs HTTP only: the live API holds data\background.lock, so this one never starts a second poller or reconciler.
for /f "usebackq delims=" %%L in (`powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0..\config\env.ps1" -EmitCmd`) do %%L
cd /d "%POKER_ROOT%\gto-trainer\apps\api"
set "PORT=2001"
rem never the background owner, even when the live :2000 worker is being restarted (services/backgroundLock.ts)
set "API_HTTP_ONLY=1"
"%BUN%" --watch index.ts
