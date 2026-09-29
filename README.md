# Poker Wrapper

The study panel that sits beside the poker table (Ignition, CoinPoker; ClubGG read-only) and shows a study answer for each decision,
plus its dashboard for looking back at sessions and hands. Windows, TypeScript (Bun), no Python.

Players install it with `PokerWrapperSetup.exe` ([setup/INSTALL.md](setup/INSTALL.md)). This repo is where it is
built from.

## What is here

| Folder | What it is |
|---|---|
| `gto-trainer/apps/wrapper` | **The wrapper**: reads the table (Ignition over CDP + WebSocket, CoinPoker from its log, ClubGG off the screen — reader only), runs sessions, the panel, the relay that presses. `:7700` |
| `ignition-study-wrapper/` | What the wrapper serves and keeps: its pages (`setup.html`, `panel.html` …), `formats.json`, card assets, launchers (`run-wrapper.vbs`, `wrapper.cmd`), its records (`data/`, `debug/`) |
| `gto-trainer/apps/api` | **The study API + dashboard**: the answer path (charts, GTO Wizard AI chains, MES), the study poller that answers the wrapper's decisions, the dashboard (`dashboard.html`). `:2000` |
| `gto-trainer/apps/api/src/charts` | **The chart server**: the chart index and node lookups every 3-handed / heads-up preflop answer reads. `:8777` |
| `gto-trainer/packages/data-root` | Where every record lives: one `poker.sqlite` ([DATA-ROOT-PLAN.md](gto-trainer/DATA-ROOT-PLAN.md)) |
| `config/` | `env.ps1` (where everything is) + `local.env` (machine-local overrides; template `local.env.example`) |
| `.claude/` | the API and chart-server supervisors, dev launchers, `launch.json` |
| `scripts/` | the GTO Wizard window (Chrome with CDP on `:9222`), its watchdog, the second account's window |
| `setup/` | install / update / repair / uninstall, the checklist (`doctor`), the packager + gate, the installer (`installer/PokerWrapper.iss`) |

## How it runs

Three background services per Windows user, registered by setup (`setup/install_tasks.ps1`), each restarting itself:

| Task | Runs | Port |
|---|---|---|
| `PokerWrapper API - <user>` | `.claude/study-api.ps1` → `bun index.ts` | 2000 |
| `PokerWrapper Charts - <user>` | `.claude/chart-server.ps1` → `bun src/charts/chartServer.ts` | 8777 |
| `PokerWrapper GTO Wizard - <user>` | `scripts/gtow_watchdog.ps1` → Chrome on app.gtowizard.com | 9222 |

The wrapper itself starts from the **Poker Wrapper** shortcut (`ignition-study-wrapper/run-wrapper.vbs`). The
dashboard is http://localhost:2000.

**GTO Wizard accounts** are rows in `<data root>/gtow-accounts.json`, edited on the dashboard's GTO Wizard tab: each
has its own DevTools port (`cdpHost`) and how its client runs — a Chrome profile of its own (the default: any number
side by side), a desktop build (`exe`; one per install), or a launcher script. The watchdog re-reads the registry every
minute and keeps every enabled account's client drivable (restarting it with the debug flag when it drops, never while
it waits for a sign-in); the tab's **Connect** button follows the same rule (`services/gtowAccounts.ts` `launchPlan`).

Development: `.claude/launch.json` has `api` (`:2000`, watch), `api-verify` (`:2001`, HTTP only — beside a live
API), `charts` (`:8777`).

## Develop

```bash
cd gto-trainer && bun install --frozen-lockfile
```

```bash
powershell -ExecutionPolicy Bypass -File setup\fetch-data.ps1
```

The second pulls the data parts (6-max preflop DB, MES turn files, node trust; ~3 GB, needs the `r2` download key)
into a fresh checkout. The answer path and the gate's mutation tests need the 6-max DB. On the chart factory's
machine, the factory's export (below) brings them instead.

- Tests: `bun test` in `gto-trainer/apps/api`, `gto-trainer/apps/wrapper`, `gto-trainer/packages/data-root`.
- **The gate:** `bun setup/regress.ts` (full: + the headless rig test + live smoke) · `--quick` · `--publish`
  (what a release requires). Run every Bun through `config/env.ps1`'s (the launchers' Bun, 1.3.14) — PATH's `bun`
  may be a different one.
- Never point a test at the live ports (`:2000`, `:7700`, `:8777`); the contract suite and the rig test bring
  their own.

## Release

`setup/publish.cmd` (or the owner's "Friend release" bar on the wrapper's setup page): the gate, then
`setup/buildPackage.ts --publish` builds the code zip, any changed data part and `PokerWrapperSetup-<version>.exe`,
and uploads them to the update channel (`r2:poker-solve-db/wrapper`, `PW_CHANNEL` overrides). Installed copies see
the blue **Update available** bar. `--stage` instead of `--publish` uploads the release without moving `latest.json`:
its installer works on any machine, but no install is offered it — a build to try first.

**Handing the installer to a machine:** `setup\handoff.cmd` (or `bun setup/handoff.ts [--version <v>] [--days N]
[--public] [--gtow <Setup.exe>]`) prints a ready-to-paste message with 7-day download links — the installer on the
channel, the key, and the GTO Wizard desktop app's installer when one is in Downloads — and `--public` also copies them
to `C:\Users\Public\PokerWrapper` for a second Windows account on this computer.

## The chart factory

The charts, the pool model and the MES studies are **made in the `poker` repo** (the HRC solve fleet, its solve
ledger and proposals, the analysis pipeline). This repo only reads what the factory produces, and nothing here
reaches into it. The contract:

| Output | Where it lands here | How it arrives |
|---|---|---|
| chart bodies (`<id>.json.gz`) | `gto-trainer/apps/api/data/charts/` (cache) | the chart server fetches each from `r2:poker-solve-db/hrc-ui` on first use |
| the chart index (`<id>.meta.json`) | `gto-trainer/apps/api/data/charts/` | shipped in the code zip; the chart server adds new ones from R2 every 30 min |
| chart sets (each strategy's chart ids) | `gto-trainer/apps/api/data/chart-sets.json` | committed, from the factory's export |
| the pool (opponent model, exploit ranges, villain frequencies, node corpus) | `gto-trainer/apps/api/data/pool/` | committed, from the factory's export |
| study data (`mes_postflop.json`, `strategy_matrix.json`, `resolved-charts.json` …) | `gto-trainer/apps/api/data/` | committed, from the factory's export |
| 6-max preflop DB, MES turn files, node trust | `gto-trainer/apps/api/data/` (gitignored) | data parts on the update channel (the installer / updater fetch them) |

The export is one command in the `poker` repo: `bun scripts/export_to_wrapper.ts [--to ..\poker-wrapper]
[--dry-run] [--r2-index]` — then commit what moved here and publish. A machine that has the factory's MES trees
and river binaries can point at them with `MES_TREE_DIR`, `MES_EXTRACT_BIN`, `RIVER_MES_BIN`
(`config/local.env.example`).

The flow back: every decision with no chart is written to the miss queue in the central `poker.sqlite`; the
factory reads it to decide what to solve next.
