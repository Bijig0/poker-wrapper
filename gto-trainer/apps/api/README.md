# Study API (`gto-trainer/apps/api`)

Bun + Hono. Serves the study dashboard on **http://localhost:2000** and the JSON API under `/api`, and runs the study
poller that answers live decisions for the Poker Wrapper (`../wrapper`).

## Run it

| How | What starts |
|---|---|
| the `StudyAPI` / `PokerWrapper API - <user>` scheduled task → `.claude/study-api.ps1` | the live API on :2000 (restarted if it dies) |
| `.claude/dev-api.cmd` (launch.json `gto-api`) | a `--watch` dev API on :2000 |
| `.claude/dev-api-verify.cmd` (launch.json `gto-api-verify`) | a second, HTTP-only API on :2001 for checking dashboard edits |

All of them take their environment from `config/env.ps1` (+ `config/local.env`). Never start a bare `bun index.ts`
for the live table: it misses that environment (see the memory note on the exploit overlay).

## Where things are

- `index.ts`: the server, the routes, and start-up (the data root, the background lock, the poller).
- `dashboard.html` / `dashboard.css`: the dashboard, served from disk (an edit is live on reload).
- `src/routes`: HTTP routes. `src/services`: the answer path (`fastSolve`, `aiChain`, `gtowApi`, charts) and the
  stores. `src/feed`, `src/utils`: parsing and helpers. `src/scripts`: harnesses and backtests (`_*.ts` are scratch).
- `data/`: **tracked reference artifacts** (preflop-db.sqlite, resolved-charts.json, mes_postflop.json, ledger.json …).
- **Runtime records** (answers, stored chains, GTO Wizard requests, poller events, hands, sessions …) are NOT here:
  they live in the one central database, `<data root>/poker.sqlite`. See `gto-trainer/DATA-ROOT-PLAN.md`.
  `GET /api/dashboard/storage` shows where every store resolves.

## Tests

`bun test` (the `bunfig.toml` preload keeps every test off the live stores: under `bun test` the data root is a
per-run temp folder). `bunx tsc --noEmit -p .` typechecks. The gate for everything is `bun setup/regress.ts` from the
repo root.
