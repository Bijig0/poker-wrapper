# Cut-over: the owner's live stack from `poker` to `poker-wrapper`

Status: **prerequisites built (2026-09-28); the day not scheduled.** Until it is done the live stack (the Poker Wrapper, the study API on
:2000, the chart server on :8777, the GTO Wizard watchdog) keeps running from `C:\Users\Brady\poker`, and
`poker-wrapper` is the repo releases are built from.

## Where it ends up

```
C:\Users\Brady\poker-wrapper     THE PRODUCT, live: wrapper :7700, study API :2000, chart server :8777 (TS),
                                 GTO Wizard :9222 — tasks "PokerWrapper API / Charts / GTO Wizard - Brady"
C:\Users\Brady\poker             THE CHART FACTORY: a factory API on :2100 (ledger, proposals, runbook, tasks board,
                                 job dispatcher, box keeper, patch jobs) — task "PokerFactory API"
C:\Users\Brady\poker-data        THE RECORDS both read: poker.sqlite (hands, answers, chains, miss queue, sessions …),
                                 api\ (job logs, caches), wrapper\ (profiles.json, tables, hand history), wrapper-debug\
                                 (recordings) — POKER_DATA_DIR in both repos' config\local.env
```

Why one records folder for both: the factory reads what play produces (the miss queue drives "what to solve next",
backtests read hands and answers), and the product reads nothing of the factory's records. Two data roots would cut
the miss queue off from the factory.

Why the product reads the factory's files directly on this machine: today a chart the fleet lands is answered from
within a minute (patch charts auto-live), and a refit pool is armed at the next API start. The export
(`poker/scripts/export_to_wrapper.ts`) stays what feeds releases to other people; on the owner's machine,
`config\local.env` points the product at the factory's live outputs so nothing waits for an export.

## Prerequisites (code, done and gated before the day)

1. **DONE — poker: factory mode for its API** (poker `7dbb6fd2`, 2026-09-28). `FACTORY_MODE=1` on :2100:
   - its own background lock (`<data>\api\factory.lock`) and exempt from the "any port but 2000 is HTTP-only" rule;
   - starts the job dispatcher + box keeper only — no study poller, token keeper, reconciler, hand-history check or
     replay scheduler (those are the product's); `POST /api/study-poller/*` answers 409;
   - the dashboard keeps every page; the live API's split-store refusal applies to it (it writes the shared root);
   - the supervisor is `.claude\study-api.ps1 -Factory` (port 2100 by default, `-Port` overrides): its own logs
     (`factory-supervisor.log`, `factory-api.log`), its straggler sweep and probes on ITS port (the plain one kills any
     bun on :2000), and it counts only supervisors started from the same script file in the same mode — poker's
     `-Factory` supervisor, poker's plain one and poker-wrapper's never evict each other. Without the switches: unchanged.
   Smoke (HTTP-only on :2101, so the live box keeper was not doubled): ledger 44 configs, /proposals 200, poller POST 409.
2. **DONE (code) — the factory's callers can be pointed at :2100.** `boxQueue.ts` already reads `STUDY_API`; `boxJob.ts`
   now reads it for `/api/ledger/keeper` and `/api/ledger/jobs` (default :2000, unchanged). Those two calls belong to
   another session's UNCOMMITTED `boxJob.ts` work in poker-zenbook, so the two-line change is uncommitted with it. On the
   day: restart the box queue (hand-started: `bun run scripts/boxQueue.ts` in `poker-zenbook\hrc-api`) with
   `STUDY_API=http://127.0.0.1:2100`; the boxJob relays it starts inherit it. The "Study Dashboard" desktop .cmd → :2100.
3. **DONE — poker-wrapper: `FACTORY_DATA_DIR`** (poker-wrapper `4b4e6b2`). `repoPaths.factoryFile(name)`: the 6-max bake,
   node trust, resolved charts, the MES studies (flop file, turn files, reach values, river lock), the strategy matrix and
   the backtests come from `FACTORY_DATA_DIR` when set, else `data\`; a file's own override (`HRC6MAX_DB`,
   `MES_POSTFLOP`, `MES_TURN_DIR`) still wins.
4. **ONGOING — bring over what lands in poker until the day.** Ported so far: the GTO Wizard accounts registry (poker
   `1fcbe086`, `4043f254`, `713f6553`) and the miss queue's real-hands-only fix (poker `1fb39d5a`, ported by its own
   session as branch `claude/miss-queue-real-hands`, merged). Next: every poker commit touching the product paths after
   `1fb39d5a` — `git format-patch 1fb39d5a..main -- gto-trainer/apps gto-trainer/packages ignition-study-wrapper setup
   config .claude/study-api.ps1 .claude/chart-server.ps1 scripts/start_gtow_chrome.ps1 scripts/gtow_watchdog.ps1
   scripts/start_gtow_secondary.ps1` → `git am -3` here (the pool is `data/pool`, the ledger pieces `chartSets.ts`;
   factory-only hunks — ledger, jobs, box keeper, patch jobs, work queue — are dropped). Skip poker `7dbb6fd2` (factory
   mode is the factory's). Other sessions' UNCOMMITTED product work in poker must be committed and ported first, or it
   is lost to the product. From the day on, product work happens in poker-wrapper only.
5. **Both gates green on the day**: poker-wrapper `bun setup/regress.ts --publish`; poker's own.

## The day (with no session running; about 30 minutes; each step checkable)

1. **Stop everything**: end any session; `Stop-ScheduledTask StudyAPI, ChartServer, GtowWatchdog`; quit the wrapper
   (`POST :7700/quit`); make sure nothing listens on 2000 / 8777 / 7700.
2. **Back up the records**: copy `poker\data`, `poker\gto-trainer\apps\api\data\{jobs, gtow_requests*, fx.json,
   balance-acks.json, tasks.json, hh_audit}`, `poker\ignition-study-wrapper\{data, debug}` to a dated backup folder.
   (~2 GB, most of it recordings.)
3. **Make the records folder**: `C:\Users\Brady\poker-data`:
   - `poker.sqlite` (+ `-wal`/`-shm` only if the API did not close cleanly — check with a `PRAGMA wal_checkpoint`
     first), `gtow-accounts.json` ← `poker\data\`
   - `api\` ← the api runtime files above (NOT the tracked reference artifacts)
   - `wrapper\` ← `poker\ignition-study-wrapper\data\` · `wrapper-debug\` ← `…\debug\`
   Then set `POKER_DATA_DIR=C:\Users\Brady\poker-data` in BOTH `poker\config\local.env` and
   `poker-wrapper\config\local.env`, and check with `GET /api/dashboard/storage` on a verify API (:2001) that every
   store resolves inside it (no split).
4. **The browser profiles** (the Ignition sign-in, the panels' window state): move
   `poker\ignition-study-wrapper\.profile-table`, `.profile-panel*`, `.profile-leader` to
   `C:\Users\Brady\poker-data\profiles\` and set `WRAPPER_PROFILE_DIR` to it (so they never live in a checkout again).
   The Windows Credential Manager entries (service `ignition-study-wrapper`) and the GTO Wizard Chrome profile
   (`%LOCALAPPDATA%\gtow-cdp-profile`) are not in any checkout: nothing to move.
5. **poker-wrapper's `config\local.env`** (the owner's live links to the factory):
   ```
   POKER_DATA_DIR=C:\Users\Brady\poker-data
   WRAPPER_PROFILE_DIR=C:\Users\Brady\poker-data\profiles
   CHART_SOLUTIONS_DIR=C:\Users\Brady\poker\analysis\pipeline\solve\exploit_ui\solutions
   FACTORY_DATA_DIR=C:\Users\Brady\poker\gto-trainer\apps\api\data
   EXPLOIT_CHART=C:\Users\Brady\poker\analysis\pipeline\limp_study\exploit_ranges_nl25.json
   POOL_MODEL=C:\Users\Brady\poker\analysis\pipeline\limp_study\pool_model_nl25.json
   POOL_DIR=C:\Users\Brady\poker\analysis\pipeline\limp_study
   MES_TREE_DIR=C:\Users\Brady\poker\analysis\pipeline\limp_study\mes_handoff\trees_refit;C:\Users\Brady\poker\analysis\pipeline\limp_study\mes_handoff\runs
   MES_EXTRACT_BIN=C:\Users\Brady\poker\analysis\pipeline\solve\compare\target\release\extract.exe
   RIVER_MES_BIN=C:\Users\Brady\poker\analysis\pipeline\solve\compare\target\release
   GTOW_SECONDARY=1           (the Elite account on :9223, as today)
   ```
   plus every other key in `poker\config\local.env` today (copy it over first, then edit).
   With `CHART_SOLUTIONS_DIR` on the factory's folder, the product's chart server serves the 143 charts whose bodies
   are only on this machine, and a chart the fleet converts is listed at once.
6. **Services**: unregister `StudyAPI`, `ChartServer`, `GtowWatchdog` (poker's); in poker-wrapper run
   `setup\install_tasks.ps1 -Start -BothGtowAccounts` (registers "PokerWrapper API / Charts / GTO Wizard - Brady");
   register the factory's task ("PokerFactory API": `powershell -File C:\Users\Brady\poker\.claude\study-api.ps1 -Factory`,
   :2100 — the task shape install_tasks.ps1 uses: conhost --headless, at logon, restart on failure).
7. **Shortcuts**: desktop "Poker Wrapper" → `poker-wrapper\ignition-study-wrapper\run-wrapper.vbs`; add "Poker
   Dashboard" (:2000) and "Chart Factory" (:2100); "Ignition Study Tool" → `poker-wrapper\gto-trainer\study-tool.vbs`;
   "Publish Poker Wrapper update" → `poker-wrapper\setup\publish.cmd`; the Start menu "Poker Wrapper" (it still
   launches the deleted Python `run-study.pyw`) → the same as the desktop one.
8. **The Python chart server**: not a service any more. The analysis app (vite) starts it by hand on another port
   (`HRC_UI_PORT=8778`) when it is needed; the factory API reads charts from the product's :8777 like everything else.
9. **Check** (all must pass before a real-money session):
   - `poker-wrapper\setup\doctor.cmd` all green; `:2000/api/dashboard/storage` = poker-data, no split;
   - the dashboard's Hands and Sessions show yesterday's hands (the records came across);
   - `:2100` shows Solve Proposals, Tasks, the box keeper up; the box queue's next poll of patch-jobs lands on :2100;
   - the rig: a practice-table session on :7701 answers preflop (6-max, 3-max, HU) and postflop;
   - `bun setup/regress.ts` (full, with the live smoke) in poker-wrapper.
10. **Rollback** (any check red): stop the new tasks, re-enable `StudyAPI`/`ChartServer`/`GtowWatchdog`, remove
    `POKER_DATA_DIR` + `WRAPPER_PROFILE_DIR` from poker's local.env and move poker-data's contents back to their old
    folders (not the backup: it lacks whatever was played since the switch) — the
    old stack comes back exactly as it was.

## After it holds (a week of sessions)

- Delete the product from poker: `gto-trainer\apps\wrapper`, `ignition-study-wrapper`, `setup\` (the packager and
  installer), the product services' scripts, and trim `gto-trainer\apps\api` to the factory's API (it keeps the
  ledger, jobs, box keeper, proposals, runbook, tasks, the Sources work queue). Update poker's memory notes.
- Friends' installs are untouched by any of this: they keep updating from the channel, now published from
  poker-wrapper.

## Everything else that talks to :2000 / :8777 or the API's files (searched 2026-09-28)

**Must move to the factory API (:2100)** — they call pages or endpoints that are not in the product any more:

| Caller | Today | Change |
|---|---|---|
| `poker-zenbook\hrc-api\scripts\boxQueue.ts:42,159` | polls `:2000/api/dashboard/sources/patch-jobs` every minute (tier-1 patch jobs) | `STUDY_API=http://127.0.0.1:2100` where the box queue runs |
| `poker-zenbook\hrc-api\scripts\boxJob.ts:162,183` | `:2000/api/ledger/keeper`, `/api/ledger/jobs` — hard-coded | read `STUDY_API` like boxQueue, then :2100 |
| Desktop `Study Dashboard.cmd` | probes :2000, opens `:2000/runbook` | open `:2100/runbook` (or retire it for "Chart Factory") |
| `deploy\dashboard\push_code.sh:7` | `/api/ledger` on the cloud dashboard box | only if that box is still used |

**Stay on the product (:2000)** — the endpoints are still there: the analysis app (`analysis\src\gtowui\api.ts`:
`/api/ai-study`, `/api/gtow-api/spot-solution`; `PreflopDb.tsx`: `/api/preflop-db`), `river\backtest_run.py`
(`/api/fast-solver`), `limp_study\sweep_replay_answers.py` (`/api/replay/*`), `assistive-play\src\remote\run.ts`
(`/api/study-poller/status`), `scripts\start_gtow_ai.ps1` (health probe — but its fallback starts `bun index.ts`
from poker: repoint to poker-wrapper), `exploit_ui\server.py:686` (health probe).

**Chart server.** The product's TypeScript server on :8777 serves `/api/solutions` + `/api/preflop/node` only.
`limp_study\backtest_charts.py`, `promote_resolved_charts.py`, `solve\export_chart_html.py` and
`deploy\winbox\acceptDiff.ts` use those two (fine on :8777). The analysis app (`analysis\src\gtowui\api.ts:15`,
`SOLVE_DB_BASE`) also uses `/api/preflop/ranges`, `/api/villains`, `/api/mes/*`, `/api/job/*`, `/api/gtow/health`
— Python-only: it gets the Python server on :8778 (`HRC_UI_PORT=8778`, `SOLVE_DB_BASE=http://127.0.0.1:8778`),
started with the app.

**Scheduled tasks.** `StudyAPI` (entry `.claude\study-api.cmd`; no installer script registers it), `ChartServer`
(`scripts\install_chart_server_task.ps1`), `GtowWatchdog` (`scripts\install_gtow_watchdog.ps1`) → replaced by the
product's three per-user tasks. `GtowLimitProbe` (`scripts\gtow_limit_probe.ps1`, cwd `apps\api`) → re-register from
poker-wrapper (the probe script and `src\scripts\gtowLimitProbe.ts` came across).

**Files.** The factory writes its outputs into `poker\gto-trainer\apps\api\data` (`node_trust.py`,
`build_6max_preflop_db.py`, `riverlock.py`, `strategy_matrix.py`, `backtest_combined.py`, `backtest_study_answers.py`,
`promote_resolved_charts.py`, `build_mes_study.py`, the `mes_handoff\*.sh` fleet scripts) — unchanged; the product
reads them there through `FACTORY_DATA_DIR`. `linuxShardJob.ts` read-modify-writes poker's `ledger.json` — factory
only, unchanged. Already stale before this (they read pre-central-DB files, adopted on 2026-09-25):
`river\backtest_run.py` + `livemes_*.py` (`answers.sqlite`, `solves.sqlite` in api\data), `river\hhhand.py`
(`ignition-study-wrapper\data\hands.db`) — point them at `<POKER_DATA_DIR>\poker.sqlite` when they are next used.
`deploy\dashboard\sync_data.sh` (the only script that copies `data\poker.sqlite`), `scripts\sync_data.sh` and
`sync_mac_data.sh` copy whole data folders: update their source paths to `poker-data` if still used.
