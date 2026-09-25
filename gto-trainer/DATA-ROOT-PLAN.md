# One data root, one database — plan and what was built (2026-09-25)

## Why

Hand 973 (#4920419883, river 14.2 s) could not be diagnosed. Its answers reached
`gto-trainer/apps/api/data/answers.sqlite` in the main checkout. Its stored chains, GTO Wizard request ledger and
`[chain]` log lines went to the `data/` folder of a worktree the API was running from that night, and that folder was
deleted with the worktree. The hand page then followed `answers.solve_id` (a per-file row number) into the main
`solves.sqlite` and showed another hand's chain. The turn and river timelines were missing even from the poller's
event log (`trace: null`).

Root causes:

1. **No data root.** Every store worked out its own path from the source file that opened it
   (`join(import.meta.dir, "..", "..", "data", …)`), so the data followed the checkout. Only some stores had an env
   override, so overriding one split a process's records across two folders.
2. **Eight SQLite files and two JSONL logs**, joined by different keys in different places: the wrapper's
   `hands.db` found rows with `data LIKE '%"clientHandId": "X"%'`, and answers pointed at solves by row number.
3. **Row numbers used as links.** `answers.solve_id` only means something inside the file it was written to.
4. **The trace header threw on non-Latin-1 text.** `X-Answer-Trace` carried raw JSON, and any timeline containing
   `—`, `≈` or a card suit made `Headers.set` throw. An empty `catch {}` swallowed that, so every turn and river
   worth diagnosing lost its timeline.

Brady's direction: "a local SQLite db that we read off of … the dashboard reads off the same row that the
reader/study answer writes to … so we can get hands in live as well."

## What was built

### 1. `packages/data-root` — the only place a runtime path is decided
* `dataRoot.ts` resolves the root. `POKER_DATA_DIR` if set; under `bun test`, a per-run temp dir that child processes
  inherit, so no test can reach a live store; otherwise `<main checkout>/data`. The main checkout is resolved from
  git's common dir, so **a worktree writes where the main checkout does**.
* `centralDb.ts` holds **`<root>/poker.sqlite`**, the one database. `openStore(path)` opens every store (WAL + busy
  timeout). `adoptAtStartup()` folds the legacy files in once, at process start. It copies each legacy table with
  its rowids, so `/hands/<dbId>` and `solve_id` links survive. It writes a watermark into the legacy file, so rows an
  old-code process appends during the restart window are picked up next start. It renames a fully adopted file to
  `.adopted-<date>` once nothing holds it open.
* `handsSchema.ts` is the hands table, defined once for the writer (wrapper) and the readers (API). It adds
  `client_hand_id` (indexed; replaces the `LIKE` matching), `status` (`live`/`done`) and `updated_at`.
* `eventTables.ts` holds `gtow_requests` and `poller_events`, which replace the two JSONL logs and are imported from
  them at start-up.

| Record | Where it lives now |
|---|---|
| hands (live + finished), sessions, balances | `poker.sqlite` (the wrapper writes; the API reads the same rows) |
| answers (+ the `[chain]` line), stored chains, hand facts | `poker.sqlite` (API) |
| GTO Wizard requests, poller events | `poker.sqlite` tables (were JSONL) |
| jobs, miss queue, river MES | `poker.sqlite` (API) |
| job logs, exit log, caches, fx, tasks, locks, profiles.json, hand-history cache, table claims | the root's `api/` and `wrapper/` folders (legacy folders in the main checkout by default) |
| debug recordings, ws dumps | the root's `wrapper-debug/` (legacy `ignition-study-wrapper/debug` by default) |
| **tracked reference artifacts** (preflop-db.sqlite, resolved-charts.json, mes_postflop.json, ledger.json …) | unchanged — versioned with the code |

Per-store env overrides (`ANSWERS_DB_PATH`, `HANDS_DB_PATH`, `WRAPPER_DATA_DIR`, …) still work for tests and
sandboxes. The **live API (:2000) refuses to start** when one points outside the root, because that is the split
that lost hand 973. Every process prints one `[data-root]` line at start, and `GET /api/dashboard/storage` shows
where every store resolves, what was adopted, and any split.

### 2. One row per hand, live
The wrapper writes the hand's row as it is played (`status='live'`, only when the hand changes, at the END of the
loop pass after every press, with a 25 ms lock wait: a busy database skips one write, never a press). The archive
finishes **that same row** (`status='done'`). A busy database defers the archive to the next pass; it never drops the
hand. The Hands tab lists live rows on top with a `live` chip and refreshes while any are in play. A row that stopped
updating (the wrapper died mid-hand) shows as `unfinished`. Analytics, nets, reconciliation and history read
finished rows only. The dashboard's row cache is keyed on `updated_at`, so the award box patching a row after the
archive is seen too (it used to be cached without the award until a restart).

### 3. Stable keys
`GET /api/dashboard/solve/:id?hand=&key=` never shows a chain whose hand or decision disagrees with the answer's. It
looks the chain up by (client hand id, decision key), or says whose row the number is. Every place the dashboard
opens a stored chain passes the answer's hand and key.

### 4. The whole decision on its row
`X-Answer-Trace` is ASCII-escaped (`headerJson`), and a failure to set it is logged, never swallowed again. The full
`[chain]` summary also travels in `X-Answer-Chain`. The poller stores it in `answers.chain`, and the hand page shows it
under each answer, so "cached or re-solved?" is answered by the row itself.

### 5. Launchers
`config/env.ps1 -EmitCmd` hands on every key `config/local.env` sets, not a fixed list. `POKER_DATA_DIR` works from
every launcher, and `TRUST_GUARD_ALL` / `GTOW_POLL_MS` now reach an API started by `dev-api.cmd` too.

## Rolling it out
Restart the API and the wrapper together (Brady's call; see the no-rig-relaunch rule). On first start they adopt the
legacy files into `<repo>/data/poker.sqlite` and rename them `.adopted-<date>`. To move the data out of the repo, set
`POKER_DATA_DIR` in `config/local.env` with both stopped.

## Tests
`packages/data-root/*.test.ts` covers resolution, adoption (rowids, watermark, re-created files, WITHOUT ROWID,
JSONL, torn lines), retirement and busy behaviour. `apps/api/src/services/centralStore.test.ts` covers the stores →
central DB, a chain shown only for its own hand, the header escaping and the hands schema upgrade.
`apps/api/src/services/gtowRequestLog.test.ts` covers the ledger on SQLite.
`apps/wrapper/test/unit/live-hand-row.test.ts` covers the live row finished in place, and a busy database deferring
but never dropping the archive.
