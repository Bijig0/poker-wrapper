# Poker Wrapper: Python -> TypeScript port (started 2026-09-24)

Brady: "Just do the whole thing (including ignition), have regression tests now, and ensure they dont fail
after the refactor". Source of truth for WHAT the wrapper does = ignition-study-wrapper/*.py (+ sites/,
aof-model/scout/cdp.py). This app is the TypeScript replacement: same HTTP contract, same ports, same data
files (ignition-study-wrapper/data, debug, *.html pages are served from there — WRAPPER_ROOT).

## Rules for the port
- FAITHFUL first: same function names (camelCase), same comments' substance, same guards. No behaviour changes
  except: (1) auto-execute is practice/fake-table only everywhere (the Ignition real-money allowance is NOT
  ported — refused on 2026-09-24, same rule as CoinPoker), (2) bugs found by the golden diff get fixed only in
  BOTH or flagged.
- Python semantics to emulate (src/py.ts): round() = half-even on the exact double; f"{x:.2f}", f"{x:g}";
  str(float) ("2.0"); dict insertion order (use Map where iteration order matters — JS objects sort int keys!);
  min/max first-on-ties; json.dumps(", ", ": " separators, ensure_ascii) where rows are LIKE-queried;
  difflib.SequenceMatcher (src/difflib.ts).
- Clock is injectable (src/clock.ts) so the golden replays are deterministic.

## Regression net (built BEFORE porting, passes on Python)
1. Golden corpus: ignition-study-wrapper/tests/golden/record.py replays recorded inputs through the PYTHON
   modules with a fake clock and writes expected outputs (tests/golden/data/*.jsonl.gz). The TS port replays
   the same inputs and must match (apps/wrapper/test/golden.test.ts).
   - ignition reader: debug/session_*/dom.jsonl (+ log.jsonl ts/events) interleaved with debug/ws_dump*.jsonl
     frames -> per-event snapshot of /hand, state(light), live status, feed lines, ws_state, archive rows
   - coinpoker: %APPDATA%/CoinPoker/logs/main.log lines -> Room/export/table snapshots
   - pure functions: reconcile (fuzz hands), terminal, tables geometry, formats._describe/compare,
     sessions.merged_config/requirements/_strategy_preset, faketable HTML, JS templates, netcheck verdicts...
2. HTTP contract suite (apps/wrapper/test/contract/): run_state_suite fixtures against a HEADLESS wrapper
   instance on its own ports (never :7700/:7701, never Brady's rig windows) — runs against Python OR TS.
3. The Python unit tests (ignition-study-wrapper/tests/test_*.py) ported 1:1 to bun tests.

## Progress (update as you go)
- [x] A1 golden recorder (Python) + data  (reader 28 scenarios, pure 29k calls, CoinPoker 7 logs, CDP trace 67)
- [x] A2 contract suite (TS) passing against Python headless (287/287, transcript stable)
- [ ] B  modules ported (tick when its golden passes)
      DONE (goldens green): py.ts difflib.ts clock.ts win32.ts cdp.ts js/ | tables | formats | auth | balances
      | netcheck | terminal | reconcile | faketable | sessions | sites/cpFeed | sites/coinpoker | sites/cpActions
      (+ ocr.ts / win32/ocr.ps1: Windows.Media.Ocr via a kept PowerShell helper, verified on the live lobby)
      TODO launch split:
      reader(DOM) | ws | handState | archive | pick/relay | topup | net guard | router/session | admin/cp
- [ ] C  Hono server + zod contract; main.ts (takeover, loops); launchers (.cmd/.vbs), setup/update/build_package
- [ ] D  contract suite + goldens + unit ports green on TS; cutover; API validates wrapper replies with the
         shared zod schema (packages or apps/wrapper/src/contract.ts)
