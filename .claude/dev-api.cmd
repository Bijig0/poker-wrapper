@echo off
rem gto-trainer API (Bun/Hono, :2000) with the ZIP-installed Node on PATH
set "PATH=C:\Users\Brady\AppData\Local\Programs\node-v24.18.0-win-x64;%PATH%"
rem arm the preflop pool-exploit overlay (the same file start_gtow_ai.ps1 arms) —
rem without it every preflop study answer is the equilibrium chart, not the exploit
set "EXPLOIT_CHART=C:\Users\Brady\poker\analysis\pipeline\limp_study\exploit_ranges.json"
cd /d C:\Users\Brady\poker\gto-trainer\apps\api
bun run index.ts
