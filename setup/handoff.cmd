@echo off
rem Hand the installer to another machine: prints two download links (7 days) for the channel's latest release + the key,
rem and copies both to C:\Users\Public\PokerWrapper for a second Windows account on this computer. Owner's side only.
rem   handoff.cmd [--version <v>] [--days N]
for /f "usebackq delims=" %%L in (`powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0..\config\env.ps1" -EmitCmd`) do %%L
"%BUN%" "%~dp0handoff.ts" --public %*
echo.
pause
