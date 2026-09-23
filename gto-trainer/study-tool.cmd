@echo off
rem Poker Wrapper TEST RIG launcher, with a console (study-tool.vbs is the same, hidden - the desktop icon).
rem Starts the API / chart server only if their ports are dead, then the rig on :7701 (fake table, CDP :9334).
rem BUN and POKER_ROOT come from config\env.ps1. Progress: ignition-study-wrapper\debug\study-tool.log
for /f "usebackq delims=" %%L in (`powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0..\config\env.ps1" -EmitCmd`) do %%L
if not defined POKER_ROOT set "POKER_ROOT=%~dp0.."
if not defined BUN set "BUN=bun"
"%BUN%" run "%POKER_ROOT%\gto-trainer\apps\wrapper\src\tools\studyTool.ts" %*
