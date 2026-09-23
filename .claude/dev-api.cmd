@echo off
rem gto-trainer API (Bun/Hono, :2000)
rem where everything is: config\env.ps1 (repo root from this file, bun/node/python/git auto-detected, overrides
rem in config\local.env, EXPLOIT_CHART / POOL_MODEL defaults) - no machine paths in this file (2026-09-22)
for /f "usebackq delims=" %%L in (`powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0..\config\env.ps1" -EmitCmd`) do %%L
rem arm the preflop pool-exploit overlay (the same file start_gtow_ai.ps1 and
rem .claude\study-api.ps1 arm) -- without it every preflop study answer is the
rem equilibrium chart, not the exploit
rem NL25 cutover 2026-09-14 (ledger cutover-nl25): the _nl25 exports are fit to ign25_3maxasym2ci (5% / cap 4bb, the rake we actually play). The old exploit_ranges.json / pool_model_v4.json are the NL200-rake generation - 12-28% of hand classes per node differ.
rem (EXPLOIT_CHART / POOL_MODEL are set by config\env.ps1 above)
cd /d "%POKER_ROOT%\gto-trainer\apps\api"

rem ---------------------------------------------------------------------------
rem Is an API already serving :2000? The "StudyAPI" scheduled task runs
rem .claude\study-api.ps1, which keeps a worker alive and restarts it 10 s after
rem every exit -- so it is usually up without anyone having started it by hand.
rem Starting a second one here does NOT fail: index.ts sets reusePort:true, so
rem the bind succeeds silently, both processes serve, and on 2026-09-13 two of
rem them ran for 14 h. The background lock now stops the second one from running
rem a second poller / dispatcher / keeper, but a demoted dev instance is rarely
rem what you wanted, so say so before starting rather than after.
rem ---------------------------------------------------------------------------
for /f %%s in ('powershell -NoProfile -Command "try { $null = Invoke-WebRequest -Uri http://127.0.0.1:2000/api/health -UseBasicParsing -TimeoutSec 3; 'UP' } catch { 'DOWN' }"') do set "API_STATE=%%s"
if /i "%API_STATE%"=="UP" (
  echo.
  echo   An API is ALREADY serving http://127.0.0.1:2000 -- almost certainly the
  echo   StudyAPI scheduled task's worker.
  echo.
  echo   Starting this one anyway gives you a second process that serves HTTP but
  echo   owns none of the background work: no study poller, no job dispatcher, no
  echo   box keeper ^(see data\background.lock and /api/ledger/keeper^).
  echo.
  echo   To make THIS instance the one in charge, stop the other first:
  echo       Stop-ScheduledTask -TaskName StudyAPI
  echo       Get-CimInstance Win32_Process ^| ? { $_.CommandLine -match 'index\.ts' } ^| % { Stop-Process -Id $_.ProcessId -Force }
  echo.
  choice /c YN /n /m "   Start a demoted HTTP-only dev instance anyway? [Y/N] "
  if errorlevel 2 exit /b 1
)

rem --watch restarts the process whenever an imported file changes (routes,
rem services, index.ts). Data files read at request time (dashboard.html,
rem data/*.json, sqlite) are not in the module graph, so their writes do not
rem trigger a restart -- and they never needed one.
"%BUN%" --watch index.ts
