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
- [x] B  modules ported, every golden green
      py.ts difflib.ts clock.ts win32.ts cdp.ts js/ | tables | formats | auth | balances | netcheck | terminal
      | reconcile | faketable | sessions | sites/cpFeed | sites/coinpoker | sites/cpActions (+ ocr.ts)
      | ignition/{dom,ws,hand,reader,checks,shadow,recorder} | archive | relay | topup | netguard | session
      | admin | windows | view  — reader golden 28/28 scenarios, pure 29,391/29,391, CDP trace 67/67
- [x] C  Hono server (server.ts) + zod contract (contract.ts); app.ts/main.ts (takeover, mutex, loops)
- [x] D  green on TS: contract 287/287 + transcript identical to the Python recording + 44/44 /state and /hand
         replies on the reply schemas (43/43 on Python); all 23 Python unit tests ported (bun test 0 fail);
         tsc clean. API resolveHand soft-validates /state with contract.ts StateReply (warns, never blocks).
- [x] Cutover 2026-09-24 (Python kept as the fallback until a live session has run on TS):
      ignition-study-wrapper/run-wrapper.vbs (hidden, log -> server.log) -> wrapper.cmd (console; env.ps1 finds
      bun) -> bun run src/main.ts. setup.ps1 shortcut, update.ps1 Start-Wrapper + kill regex, study-tool.pyw
      (rig), run-tables.pyw, build_package CODE_TREES, regress.py (3 TS tiers). WRAPPER_IMPL=python makes the
      rig / run-tables start the Python one; launch.cmd / run-study.pyw start it directly. Either implementation
      takes over from the other on the same panel port. (Python fallback removed with the Python wrapper.)
- [x] Live session on the TS wrapper (Brady, 2026-09-24, CoinPoker HU) — found the Pot-button bug (both
      implementations; fixed in TS only, 0a57a58b).
- [x] Python wrapper DELETED 2026-09-24 (Brady: "we are going pure TS"): launch.py + modules + sites/*.py, the
      launchers (launch.cmd, run-study.pyw, run-tables.pyw, drive.py), the 22 Python unit tests, the golden
      recorders and the Python-only replay tools. Ported first, each verified against the Python before it went:
      replayWsDecisions.ts (718/718 records identical), runTables.ts, and the hand fuzzer (test/fuzz: CPython's
      Mersenne Twister in pyRandom.ts, so seed i deals the same hand — 1,200 hands identical field by field).
      Kept (not the wrapper — HTTP clients of the rig / analysis over its data): tests/rig.py, spot_audit.py,
      answer_suite.py, backtest/verdicts.py, backfill_results.py, parity_report.py. The goldens stay (corpus under
      ignition-study-wrapper/tests/golden/corpus) and are TS-owned: re-baseline with GOLDEN_UPDATE=1.
- Deliberate deviations: real-money auto-execute allowance NOT ported (practice/fake only). Fixed in both:
  table slots are spawned with --panel-port/--cdp-port in argv (a slot without them read as :7700 to the
  takeover scan, so relaunching table 1 would end table 2). TS only: unhandled rejections are logged, not fatal
  (a Python thread's exception never took the server down either).
- The "[slow] request" log line (Python's _send) is ported: a Hono middleware in server.ts.
