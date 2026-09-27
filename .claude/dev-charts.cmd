@echo off
rem The chart server on :8777 (TypeScript, gto-trainer\apps\api\src\charts\chartServer.ts): the chart index + node lookups
rem every 3-handed and heads-up preflop answer reads; chart bodies come from R2 on first use and are cached beside the index.
rem Where everything is: config\env.ps1 (checkout root from this file, Bun, HRC_UI_DOC_CACHE_MAX=6 - six parsed trees
rem resident: a ring session's working set, so hero's turn never waits on a cold open).
for /f "usebackq delims=" %%L in (`powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0..\config\env.ps1" -EmitCmd`) do %%L
"%BUN%" "%POKER_ROOT%\gto-trainer\apps\api\src\charts\chartServer.ts"
