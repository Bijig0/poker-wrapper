# One data root — plan (2026-09-25)

## Why

Hand 973 (#4920419883, river 14.2 s) could not be diagnosed. Its answers reached
`gto-trainer/apps/api/data/answers.sqlite` in the main checkout. Its stored chains, GTO Wizard
request ledger and `[chain]` lines went to the `data/` folder of the worktree the API was
running from that night, and that folder has since been deleted. The hand page then followed
`answers.solve_id` (a per-file row number) into the main `solves.sqlite` and showed another
hand's chain. The turn and river timelines were missing even from `poller-events.jsonl`:
`trace: null`.

Three root causes:

1. **No data root.** Each store works out its own path, mostly relative to the source file
   that opens it (`join(import.meta.dir, "..", "..", "data", …)`), so the data follows the
   checkout. Only some stores have an env override (`ANSWERS_DB_PATH`, `HANDS_DB_PATH`, …),
   so overriding one splits a single process's records across two folders.
2. **Row numbers used as links.** `answers.solve_id` only means something inside the one
   `solves.sqlite` it was written to.
3. **The trace header throws on non-Latin-1 text.** `X-Answer-Trace` carries JSON. Any
   timeline containing `—`, `≈` or a card suit makes `Headers.set` throw, the `catch {}`
   swallows it, and the timeline is lost. That hits every turn/river whose `[chain]` text
   says "CREATED … — why" or carries a fallback note, i.e. the slow decisions.

## What changes

### 1. `@poker/data-root` — the only place a runtime path is decided
`gto-trainer/packages/data-root/dataRoot.ts`, imported by both apps:

| Store (runtime records) | Legacy location (default) | Under `POKER_DATA_DIR=X` |
|---|---|---|
| API: answers, solves, gtow_requests, jobs/ (poller-events, logs), jobs.sqlite, miss-queue, river_mes, hand_facts, fx, tasks, balance-acks, background.lock, mes_river_cache, hh_audit | `<main>/gto-trainer/apps/api/data` | `X/api` |
| Wrapper: hands.db, sessions.sqlite, profiles.json, auth_pages, hand_history, tables/, shadow.jsonl | `<main>/ignition-study-wrapper/data` | `X/wrapper` |
| Wrapper debug recordings + ws_dump | `<main>/ignition-study-wrapper/debug` | `X/wrapper-debug` |

* `<main>` is the **main checkout**, resolved from git's common dir, not from the running file.
  A worktree API or wrapper therefore writes to the same place as the main one, so the
  hand-973 split cannot happen. (Before: a worktree wrote into its own `data/`, which vanished
  with the worktree.)
* Under `bun test` (NODE_ENV=test) the root is a per-process temp directory, so no test can
  reach a live store, whichever store it opens. This generalises the answerLog/handFacts guards.
* Per-store overrides (`ANSWERS_DB_PATH`, `HANDS_DB_PATH`, `SESSIONS_DB_PATH`,
  `PROFILES_JSON_PATH`, `HAND_FACTS_DB_PATH`, `WRAPPER_DATA_DIR`, `WRAPPER_DEBUG_DIR`,
  `IGNITION_DEBUG_DIR`, `API_BACKGROUND_LOCK`) keep working, since tests and verify servers
  use them. They are reported, and the **live** API (serving the poller) refuses to start when
  one points outside the data root. That is the partial-override split that lost hand 973.
* Tracked reference artifacts (preflop-db.sqlite, resolved-charts.json, mes_postflop.json,
  strategy_matrix.json, ledger.json …) stay beside the code: they are versioned with it.
* Visibility: the API and wrapper print one `[data-root]` line at start (root, where each store
  resolves, overrides); `GET /api/dashboard/storage` returns the same report.

### 2. Stable keys between stores
* `GET /api/dashboard/solve/:id?hand=<clientHandId>&key=<decisionKey>`: a row whose hand or
  decision disagrees is **never** shown. The server looks the chain up by (hand, decision
  key) instead, or answers "this hand's stored chain is not in this data root (row #72 belongs
  to hand 9000057)". The hand page passes both.

### 3. The whole decision in one record
* `X-Answer-Trace` is written ASCII-safe (`\uXXXX` escapes inside the JSON), so `—`, `≈` and
  suits no longer drop the timeline.
* The API also returns the full, uncut `[chain]` summary in `X-Answer-Chain`. The poller stores
  it on the answer row (`answers.chain`, additive column), and the hand page shows it under
  each answer. "Cached or re-solved?" is then answered by the row itself, whatever happened to
  the logs.

### 4. Moving the data out of the repo (optional, needs everything stopped)
`bun setup/moveData.ts --to C:\Users\Brady\poker-data` copies the runtime stores into the new
layout (SQLite through `VACUUM INTO`, so WAL contents come along), verifies row counts, and
prints the `POKER_DATA_DIR` line to put in the launch env. It refuses while :2000 or :7700
answers. It is not run automatically: the API and wrapper have to be stopped, and restarts are
Brady's call.

## Order
1. data-root module + tests
2. API stores → module (answers, solves, gtow ledger, poller events, jobs, miss-queue, river MES,
   tasks, fx, acks, lock, exit log, hands/sessions/profiles readers)
3. wrapper `env.ts paths()` → module
4. live split guard + `[data-root]` report + `/storage`
5. solve lookup by (hand, key) + hand page
6. trace header escape + `X-Answer-Chain` + `answers.chain` + hand page
7. moveData.ts
8. Gates: api `bun test`, wrapper `bun test`, `tsc`, `bun setup/regress.ts`
9. Rebase onto the integration SHA from the "Answer chain architecture review" session. chain-ledger's
   `handFacts.ts` resolves through the module too. Re-run the gates on the combined code.
