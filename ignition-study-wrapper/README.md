# Ignition Study wrapper (skeleton)

**STUDY / PRACTICE-MONEY ONLY.** A one-click Windows wrapper that opens the
Ignition web client and the study panel side by side:

```
┌─────────────────────────────┬───────────────┐
│  Ignition web client        │  Study panel  │
│  (Chrome app-mode window,   │  status, live │
│   --remote-debugging-port)  │  mirror, DOM  │
│                             │  probe        │
└─────────────────────────────┴───────────────┘
        └── CDP :9333 ──► launch.py panel server (:7700)
```

## Run

```
launch.cmd
```

Log into Ignition in the left window (the dedicated `.profile-table` Chrome
profile keeps the session across launches) and open a **practice-money** table.

## What the skeleton already proves

- One command → table window + panel beside it, sized to the work area
  (`TABLE_FRAC`, default 70/30).
- CDP connectivity to the table window — the same channel the live feed
  (phase 2) and Remote Play clicks use. No screen-capture APIs anywhere.
- **Live mirror**: the panel shows a CDP screenshot of the table page every
  ~2.5s — the exact frame source the OCR pipeline would consume.
- **Dump DOM sample**: extracts visible text nodes from every frame and gives a
  verdict — DOM-readable (CoinPoker-style feed, phase 2 gets cheap) vs
  canvas-rendered (OCR path, port the assistive-play vision pipeline).

## Debug recordings (`debug/session_*/`)

Toggled from the panel. Each tick writes three joinable artefacts, keyed by the
same `seq`:

| file | contents | role |
|---|---|---|
| `fNNNNN.jpg` | the exact frame | human adjudication only — lossy (q55 @ 0.6), never assert on it |
| `log.jsonl` | the **parsed** state + feed tail | what we made of the table |
| `dom.jsonl` | the **raw** `_TABLE_JS` output | what the client actually gave us |

`dom.jsonl` is the one that cannot be reconstructed later. It is both the replay
fixture for testing the reader against real DOM and the parity target any table
replica has to match — a replica checked against our own parsed output would
only prove the reader agrees with itself. Each entry carries the client's CSS
`zoom` alongside viewport coordinates, so design units are
`(viewport - frame origin) / zoom`.

Measured cost at the 4 Hz feed loop: frames 63 KB each (~900 MB/h) plus
`dom.jsonl` at 5–8 KB/tick (~90 MB/h). `_prune_debug` counts both against
`DEBUG_BUDGET_MB` (default 2000) and drops oldest-first, never the newest two
or any session with a `note.txt` — so about two hours of recording fits before
older sessions start going. Record deliberately, and drop a note in any session
worth keeping.

Frames are captured with **no CDP `clip`**. A clip with `scale != 1` makes
Chrome relayout the page at that scale and snap back, which on a headed window
strobes the table you are playing on. Lower `_shot_jpeg`'s `quality` to buy
disk; never reintroduce the clip.

## Game-state tester (`/faketable`)

Author any Ignition state and run the study tools against it locally — no
client, no network, no real table. `faketable.py` renders a spec as BOTH the
client's structural DOM contract (the data-qa hooks the reader consumes) and a
faithful visual replica (measured geometry from types.ts, the real card art
and harvested client SVGs), in the same document — so what the reader parses
and what you eyeball are the same table by construction.

- `POST /faketable/load` — spec in, test mode on: seeds the hand state from
  the spec's `node`, renders the table, reloads the tab. `/hand`, the study
  poller and the `/act` relay then run unchanged.
- `POST /faketable/stop` — back to live reading.
- `GET /faketable/lastclick` — what the relay actually pressed (the page
  records every button hit).
- Fixture suite: `tests/run_state_suite.py` over `tests/fixtures/*.json` —
  each fixture asserts the /hand export field by field, that each expected
  action fires the right control, and that unoffered actions are refused.
- Authoring UI: the dashboard's State Tester page (:2100/state-tester).

Test mode stands down the WS tap, the DOM feed diff and the archiver: every
fact of an authored state is authored, so anything inferred is a phantom and
nothing lands in hands.db.

## Phases

1. ✅ this skeleton
2. live hand feed: CDP frames → OCR (`winocr`) / DOM → assistive-play
   `HandTracker` → large-print panel feed
3. Study Answers: gto-trainer (`localhost:2000`) verdicts in the panel —
   practice tables only, per the assistive-play bright line

Reuses `aof-model/scout/cdp.py` (Windows-validated) for all CDP access.
Env overrides: `IGNITION_URL`, `CDP_PORT`, `PANEL_PORT`, `CHROME_EXE`,
`TABLE_FRAC`.
