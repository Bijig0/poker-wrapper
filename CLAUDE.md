# Poker Wrapper — notes for Claude

Read README.md first: what each folder is, the three services and their ports, the chart-factory contract.

- **This repo is the product** (the wrapper + the study API/dashboard + the chart server + the installer). The chart
  factory — the HRC solve fleet, the solve ledger, proposals, runbook, the task board, the analysis pipeline — is
  the `poker` repo. Nothing here may reach into it (no `analysis/`, `hrc-api/`, `poker-zenbook` paths): factory
  outputs arrive through R2 or `poker/scripts/export_to_wrapper.ts`, and paths come from
  `gto-trainer/apps/api/src/services/repoPaths.ts` (+ env overrides).
- **Do not hand-edit factory outputs**: `data/chart-sets.json`, `data/pool/*`, `data/mes_postflop.json`,
  `data/strategy_matrix.json`, `data/resolved-charts.json` … — re-export from the factory.
- **The gate:** `bun setup/regress.ts --publish` (all green before any commit that touches the answer path).
  Use config/env.ps1's Bun (1.3.14, `C:\Users\<you>\AppData\Local\Programs\node-v*\node_modules\bun\bin\bun.exe`
  on the owner's machine) — PATH's `bun` can be a different version that behaves differently.
- **What is live — a merge to main is the deploy** (2026-10-03). The live services run the MAIN checkout of this
  repo, and each reads its code once, at start. A commit on `main` that changes a file a service loaded restarts the
  API and the chart server by themselves (`services/autoRestart.ts`) — within about a minute when no poker session is
  live, at the end of the session when one is. Nothing else goes live by itself: not a branch, not a worktree, not an
  uncommitted edit in the main checkout. So:
  - **Merge every finished change into `main` at once** (commit on your branch, run the gate that fits, merge). Work
    parked on a `claude/*` branch is the stale code the owner keeps meeting.
  - **"Done" means running**: `bun setup/live.ts` prints one line per service (commit, uptime, current or why not)
    and what is not on main; `bun setup/live.ts --wait` after a merge waits for the restart. Report "merged, live" or
    "merged, restart held until the session ends" — never just "fixed". `GET :2000/api/build/all` is the same answer.
  - The states it names: `settling` (restarting in seconds), `held` (a session is live), `uncommitted` (edits nobody
    committed — never picked up automatically), `boot-check-failed` (the code on disk does not bundle; the old process
    keeps serving — fix it), `unsupervised` (a hand-started process, or the wrapper: it has no supervisor, a launch
    always loads the disk, and the setup page offers Relaunch).
  - **Supervisors are code too**: `.claude/study-api.ps1`, `.claude/chart-server.ps1`, `scripts/gtow_watchdog.ps1`
    read themselves, `config/env.ps1` and `config/local.env` once. After editing any of those the SUPERVISOR must be
    restarted (the worker restarting is not enough) — `live.ts` shows `OLD supervisor: <name>`. Recipe, when no
    session is live: `Stop-Process` that supervisor's powershell (never `/T`: the watchdog's children are the GTO
    Wizard windows), then `Start-ScheduledTask "PokerWrapper API - <user>"` (`… Charts …`, `… GTO Wizard …`). Never
    Stop/Start the task while its supervisor is still running.
  - Pages (`dashboard.html`, `static/study`, `setup.html`, `panel.html`) are read from disk on every request: an
    edit in the main checkout is live on save, ahead of the routes behind it — land the route first, or in the same
    merge.
  - `AUTO_RESTART=off` in `config/local.env` turns the automatic restart off (the reporting stays).
- **Never test against the live ports** (:2000 API, :7700 wrapper, :8777 charts, :9222 GTO Wizard). Beside a live
  stack: `.claude/dev-api-verify.cmd` (:2001, HTTP only), `HRC_UI_PORT` for a second chart server, the contract
  suite and rig test pick their own ports. Never relaunch the owner's `:7701` test rig without asking.
- **Ports come from one rule**: `gto-trainer/apps/api/src/services/ports.ts` (TypeScript) and the same table in
  `config/env.ps1` (PowerShell) — `PORT_OFFSET` in `config/local.env` shifts all of them (a second Windows account's
  install beside the owner's). Never write a literal 2000/8777/7700/9222 in code or a script: use `port()` /
  `livePort()` / `apiUrl()`, or `$env:PORT` etc. after dot-sourcing env.ps1. Browser files may keep the defaults —
  they are rewritten on the way out (`rewritePorts`, only the `:2000` form).
- **Tests are hermetic**: they must not read untracked data (the chart index, the data parts). Use a fixture
  (`src/services/__fixtures__`) or a test hook (`setIgn25Ids`, `CHART_SETS_PATH`, `MES_TURN_DIR`).
- Installer: `bun setup/buildPackage.ts --installer` (needs Inno Setup, `winget install JRSoftware.InnoSetup
  --scope user`). A test install beside a live one: `PokerWrapperSetup.exe /VERYSILENT /NOSERVICES /TASKS=""
  /KEYFILE=<key> /DIR=<scratch>` — `/NOSERVICES` keeps it off the live ports; uninstall with its `unins000.exe`.
- Windows gotchas: always `%SystemRoot%\System32\tar.exe` (Git's GNU tar cannot read zips); PowerShell 5.1 reads a
  BOM-less `.ps1` as ANSI (keep them ASCII or BOM'd); `ErrorActionPreference = 'Stop'` turns a native tool's stderr
  note into a fatal error.
