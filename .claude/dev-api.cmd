@echo off
rem gto-trainer API (Bun/Hono, :2000) with the ZIP-installed Node on PATH
set "PATH=C:\Users\Brady\AppData\Local\Programs\node-v24.18.0-win-x64;%PATH%"
rem arm the preflop pool-exploit overlay (the same file start_gtow_ai.ps1 arms) —
rem without it every preflop study answer is the equilibrium chart, not the exploit
set "EXPLOIT_CHART=C:\Users\Brady\poker\analysis\pipeline\limp_study\exploit_ranges.json"
cd /d C:\Users\Brady\poker\gto-trainer\apps\api
rem --watch restarts the process whenever an imported file changes (routes,
rem services, index.ts). Data files read at request time (dashboard.html,
rem data/*.json, sqlite) are not in the module graph, so their writes do not
rem trigger a restart -- and they never needed one.
bun --watch index.ts
