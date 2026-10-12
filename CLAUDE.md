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
  - **Supervisors are code too — and pick up their own changes** (2026-10-10, `scripts/supervisor_lib.ps1`,
    `services/supervisorRestart.ts`). `.claude/study-api.ps1`, `.claude/chart-server.ps1`, `scripts/gtow_watchdog.ps1`
    stamp what they read (`data/jobs/supervisor-<name>.json`, protocol 2). The API and chart supervisors RE-READ
    `config/env.ps1` + `config/local.env` before every worker start (the port excepted), and their worker restarts
    itself for a local.env change (`reason: env-changed`, plain exit 0) when no session is live. A change to the
    supervisor's own script / the lib / a port key (`supervisor-changed`) makes the worker write
    `data/jobs/supervisor-<name>.replace.json` and exit 3; the supervisor then starts `scripts/supervisor_replace.ps1`
    detached and exits 0 — the helper waits for it and its console to go, `Start-ScheduledTask`s it again, and falls
    back to spawning the script directly. The watchdog has no worker: the API writes its request file, it checks every
    minute. Guards: held while a session is live, at most one per supervisor per 5 min, worker up >= 60 s, supervisor
    up >= 2 min, refused (stamp `refused`, shown as boot-check-failed) when a file would not parse. `AUTO_RESTART=off`
    stops it (reporting stays). The setup page / `live.ts` say "will restart itself when no session is live".
    A supervisor started from an older script (no protocol 2) is only reported: restart it by hand ONCE.
    A worker finds its stamp by NAME and takes the stamp's pid as its supervisor while that pid is alive — the chart
    supervisor ADOPTS a server already on its port ("already served … watching it", re-stamped with `adopted`), and
    that worker's POKER_SUPERVISOR still names the old supervisor. Stamp pid dead and no live one in its env = `gone`:
    reported (`supervisor-old` / `unsupervised`), never exited. `auto.watch` in `/api/build` shows the link.
  - By hand, when no session is live: `Stop-Process` that supervisor's powershell (never `/T`: the watchdog's children
    are the GTO Wizard windows), then `Start-ScheduledTask "PokerWrapper API - <user>"` (`… Charts …`, `… GTO
    Wizard …`). Never Stop/Start the task while its supervisor is still running. **The task-scheduler trap:** after a
    `Stop-Process` of a supervisor its headless `conhost.exe` can linger (parent = the task engine, NO children) and
    the task refuses a new instance (LastTaskResult 0x800710E0) while it reads "Running" — stop that conhost (it has no
    children) and start the task again. A clean exit (what a self-replace does) takes its conhost with it.
  - **A degraded runtime restarts too** (2026-10-12, `services/runtimeHealth.ts`): an API worker that slept through a
    long lid-close (11-14 h) came back at ~250% CPU with its loop blocked ~75%, until replaced. The worker now replaces
    itself (reason `runtime-degraded`, exit 0, held while a session is live) after a suspend of 30 min or more (logged
    as `[suspend]`, not as a stall) or after two 5-min windows at ≥150% CPU and ≥20% blocked (once an hour at most).
    `[stall-summary]` lines carry `this process N% cpu (rss, js heap)`. `DEGRADED_RESTART=off` reports only.
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
- **Test temp dirs come from `src/test/tempDir.ts`** (`testTempDir(prefix, { release })`): removed in the file's
  afterAll after `release` closes the handles (bun test fires no process exit hooks; Windows refuses to delete an open
  sqlite). Never bare `mkdtempSync` in a test. `KEEP_TEST_TMP=1` keeps them; leftovers from killed runs:
  `bun src/scripts/sweepTestTemp.ts` (from apps/api).
- Installer: `bun setup/buildPackage.ts --installer` (needs Inno Setup, `winget install JRSoftware.InnoSetup
  --scope user`). A test install beside a live one: `PokerWrapperSetup.exe /VERYSILENT /NOSERVICES /TASKS=""
  /KEYFILE=<key> /DIR=<scratch>` — `/NOSERVICES` keeps it off the live ports; uninstall with its `unins000.exe`.
- Windows gotchas: always `%SystemRoot%\System32\tar.exe` (Git's GNU tar cannot read zips); PowerShell 5.1 reads a
  BOM-less `.ps1` as ANSI (keep them ASCII or BOM'd); `ErrorActionPreference = 'Stop'` turns a native tool's stderr
  note into a fatal error.
