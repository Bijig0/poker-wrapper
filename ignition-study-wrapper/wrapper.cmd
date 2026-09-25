@echo off
rem Poker Wrapper - the TypeScript wrapper (gto-trainer\apps\wrapper), with a console. The desktop shortcut runs
rem run-wrapper.vbs, which starts this same file hidden and sends the log to server.log. Arguments pass through:
rem   wrapper.cmd [--panel-port N] [--cdp-port N] [--fake]
rem BUN and POKER_ROOT come from config\env.ps1, not a machine path.
for /f "usebackq delims=" %%L in (`powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0..\config\env.ps1" -EmitCmd`) do %%L
if not defined POKER_ROOT set "POKER_ROOT=%~dp0.."
if not defined BUN set "BUN=bun"
"%BUN%" run "%POKER_ROOT%\gto-trainer\apps\wrapper\src\main.ts" %*
