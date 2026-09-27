@echo off
rem A second gto-trainer API on :2001 for checking dashboard edits without restarting the live :2000 one.
rem It runs HTTP only: the live API holds data\background.lock (no second poller / dispatcher / keeper), and
rem PLAYER_MODE=1 keeps the solve fleet off even if it ever got the lock.
for /f "usebackq delims=" %%L in (`powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0..\config\env.ps1" -EmitCmd`) do %%L
cd /d "%POKER_ROOT%\gto-trainer\apps\api"
set "PORT=2001"
set "PLAYER_MODE=1"
rem never the background owner, even when the live :2000 worker is being restarted (services/backgroundLock.ts)
set "API_HTTP_ONLY=1"
"%BUN%" --watch index.ts
