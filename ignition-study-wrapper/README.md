# Poker Wrapper (was "Ignition Study")

**One wrapper, two sites (2026-09-22).** The session setup page starts with a
**Site** step: **Ignition** (everything below: the web client in our own browser,
CDP + WebSocket reader, router, sign-in, top-ups, 1-4 tables) or **CoinPoker**
(`sites/coinpoker.py`: the desktop client's own log is the reader — `cp_feed.py`
— and presses are real input on the Unity table, OCR-checked before and confirmed
from the log after — `cp_actions.py`). A CoinPoker session opens the client if
needed and follows whichever table you sit at; it has no router, sign-in, top-up
or balance scraper, and auto-execute arms only on a Practice Games table. Both
sites archive into `data/hands.db` (CoinPoker rows carry `site: "coinpoker"`).
`/state.site` says which site the session plays; `POST /sitout {on, all}` is the
CoinPoker Sit Out Next Hand / Sit Out All. gto-trainer refuses to answer a
CoinPoker hand until a CoinPoker strategy exists (resolveHand). The folder keeps
its old name because gto-trainer reads its data paths.


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

## Study pick → the relay (accessibility)

The panel's pick box is a button: one press (or Enter / Space) relays the
rolled study pick to the table through the SAME relay the action buttons use
(`POST /act/pick`). The user still decides every action — they just have one
target instead of reading the mix and choosing among three or four buttons.

`auto-execute` (the checkbox under the pick, `POST /study-auto`) fires the
pick without a press. It arms freely on a practice-money table (`playMode=fun`)
or the fake table. A REAL-MONEY table needs an explicit, expiring allowance
(`allowRealMoney` + a minute AND hand budget, clamped to 120 min / 500 hands);
it disarms itself the moment either budget runs out, and the panel row turns red
and counts it down. Granted 2026-09-14 only because the practice tables never
had enough players to deal a hand. Either can be **declared up front** on the
setup page (Settings → Auto-execute picks) — the declaration decides the state
the panel opens in, and the panel's toggle always wins. It is per session and
never inherited. Both paths run the same guards (`/state.pickReady`): answers on, a
fresh pick, hero on the clock, and the pick's decision key still matching the
table's hand, street and action count — a Zone hand moves on, a stale pick
must not land on it. One execution per decision; a sized raise is typed into
the client's bet field and read back, and a clamped value is refused rather
than pressed. CONTRACT.md §2a has the shapes.

Tests: `tests/test_pick_relay.py` (offline: label mapping, every guard, the
executor, the auto gate) and `tests/test_pick_relay_rig.py` (on the test rig:
the right control fires on the fake table, the typed size reaches the bet
field, clamps and stale/wrong-hand picks are refused, auto fires once).

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

## State reading — levels before words, three turn signals, nothing silent

How the wrapper decides what the table says (2026-09-19, after hand 4919080696
went unanswered for 19 s because a villain's "SITTING OUT" label was read as
hero's):

- **Hero's turn** has three independent sources, compared every tick
  (`_state_check`): the client's own action request on the WebSocket
  (`CO_SELECT_REQ` → `heroTurn`), the action buttons on screen, and
  `CO_CURRENT_PLAYER`. Any of them puts hero on the clock in `/hand`; a
  disagreement that holds ~1 s is a `state-check` session event, a feed line
  and a `/state.stateHealth` entry (CONTRACT §1b).
- **Hero's status** (`_hero_status`): a hero the client dealt in, or whose
  seat shows hole cards, is never sitting out. Status words are captured
  per seat by the DOM reader (`seatQa[].status`) and only count for hero from
  hero's own container, and only when hero holds no cards.
- **The betting line** (`_reconciled_line`, CONTRACT §1c): the level
  reconciler's line replaces the event log's when they differ and its
  derivation was clean; a fault that is STILL TRUE marks the answer
  `uncertain` and auto-execute holds.
- **A hold is a pause, not a verdict** (2026-09-19): faults live and die
  (`HandReconciler.faults()`), the hold is re-tested every tick, and it lifts
  itself the moment the disagreement stops. It used to retire the decision, so
  a single flickering tick made hero play the rest of the street by hand.
- **Told vs did** (`_maybe_verify_exec`, CONTRACT §2a): a relayed press is
  checked against the table's own chips — hero's action must appear at the
  index the decision key names and be the action that was sent. `confirmed` /
  `diverged` / `unknown`, with one retry and only on proof that nothing landed.
  A click that dispatched is not an action that happened.
- **Nothing about a live hand is final** (CONTRACT §1a3): settle before committing,
  retract when contradicted (`reconcile._revive` — `ended` was set in six places and
  cleared in none), and re-ask only when something changed. Across every recording,
  recovery fires on 22 of 244 hands and recovers actions on 16 of them.
- **Nothing silent**: `/hand` carries `buttonsUp` + `notToActWhy`; the API's
  poller writes a `not-to-act-live` failure row (and shows it on the panel)
  when the buttons stay up 2 s while the export says it is not hero's turn.
- **Receipts over inference**: the client's "You have successfully added $N
  in chips." toast confirms a top-up whatever the Buy-chips panel looked like.
- **Gated at the press, not at the decision** (`_top_up_gate`): the top-up
  presses run on their own thread seconds after the decision to make them, so
  every one of them re-reads the table first. Hand 8 of session 125204 opened
  the Buy-chips panel into hero's turn; the strip took it straight back and the
  stack sat at 98.5 bb through the blinds. TWO dangers only — hero on the clock,
  a notice over the strip. The hand number is not one of them: 41% of the windows
  between hero's last turn and the next deal are shorter than a full run takes, so
  aborting on the deal abandoned the panel about as often as it protected anything.
  A run that has started finishes; the chips land at the next hand either way.
- **The top-up waits for the hand to be over, not for the pot graphic** (2026-09-19):
  the old rule wanted the pot label gone, and Ignition often keeps it on screen until
  the next hand deals — so three of the four hands hero played to the end and finished
  short in session 173224 could never trigger, and he sat at 86-92 bb for five hands.
  Now: hand over (folded, or the client's end marker) + hero's stack settled for two
  ticks. Nothing is pressed mid-hand while hero can still act: the chips cannot join a
  live hand, and the shortfall would be read off a stack that still has money in the pot.
- **Three windows, named** (`_top_up_window`, 2026-09-20): `not-dealt` — hero is sitting
  out, waiting for the big blind, or was not dealt in, so he can neither be put on the
  clock nor win a chip and the WHOLE hand is safe; `fold` — hero's fold is confirmed and
  his stack behind is already final, so nothing has to settle; `hand-over` — the client's
  end marker plus a settled stack. The fold window is the one worth having: over 122
  recorded folds the median lead to the next deal is **40.8 s**, and only 5 are under 3 s.
  `tests/replay_topup.py` scores the rule over every recording — short hands with a window
  to press in go **51/63 (81%) → 63/63 (100%)**. The scheduler and the per-press gate call
  the same function, so a window that starts a run cannot be one the next press disputes.
- **The panel is NOT pre-staged during the hand.** Opening it early would buy back only
  the 4% of windows that are tight, at the price of leaving a modal over the action strip
  for the other 96%. Instead the modal is guarded from both sides: `_maybe_guard_buy_panel`
  closes it the moment hero is put on the clock, and `act()` folds it away before relaying
  any action. `_close_buy_panel` is idempotent — the press is a toggle, so closing a shut
  panel would open it over the strip.
- **One big blind is the smallest shortfall worth a press** (`TOP_UP_MIN_SHORT_BB`). The
  old floor was a twentieth of a big blind, i.e. anything at all. A small random wait
  (`TOP_UP_JITTER_S`) separates the press from the fold it follows.
- **The number that matters is on the panel**: hands hero STARTED below the table max,
  read off the client's own stack plus everything he has committed this hand (the blinds
  are gone from the seat label by the first tick, so a raw reading calls every big blind
  one bb short). Presses, receipts and windows are all proxies, and they read healthy all
  September while that count climbed: 11 presses on record against 24 short hands played
  out untouched. Drive it to zero.
- **Does Ignition take a second buy in one hand?** Unanswered — the one natural experiment
  on record (session 100647, hands 9 and 10) is confounded, because the second press is
  also the one where the panel never opened. `POST /topup/test-second` settles it at a live
  ring table: two small buys back to back, with the client's verdict on each.

## Which screen it opens on

The EXTERNAL monitor whenever one is attached, the laptop panel when not.
`STUDY_MONITOR=primary|external|cursor` overrides.

This is deliberately a rule that does not depend on the moment it is asked.
`target_area()` is re-read at five points over the first seconds of a launch —
startup, surfacing the panel, opening the table window, and two delayed
`apply_layout` timers — so the old `cursor` rule ("the screen the mouse is on")
gave a different answer at each one: of thirteen identical launches on
2026-09-19, twelve landed on the laptop panel and one on the external, with
nothing different but where the pointer happened to be. Four tiled tables need
it stable too. "External" means the non-primary monitor; if the external is ever
made Windows' primary display, set `STUDY_MONITOR=primary`.

**A monitor that is attached but ASLEEP still gets enumerated**, so the layout
will happily put the table there — and the page then reports `hasFocus(): true`
with `visibilityState: hidden`. Chrome parks synthetic input on a page producing
no frames, so every relayed click used to spend five seconds in the socket and
come back "Connection timed out". `_ensure_visible` now tries `bringToFront`,
re-checks, and REFUSES with the real reason instead. If the relay says *"the
table window is not rendering"*, wake the screen.

## Several tables (1-4)

    aof-model/.venv/Scripts/pythonw.exe run-tables.pyw 4        # four tables
    aof-model/.venv/Scripts/pythonw.exe run-tables.pyw --stop

Four wrapper processes on panel ports 7700/7710/7720/7730, sharing ONE Chrome
profile — one process, one login, one CDP port, four app windows. Each wrapper
claims its own window by Chrome targetId (`tables.py`) and opens another on the
shared profile if it cannot claim one, so starting N wrappers IS the setup: no
orchestrator hands out windows, and a wrapper restarted on its own takes its
window back. The API keeps one study poller per wrapper, each registering itself.

`run-tables.pyw 1` is the single-table setup and takes none of the multi-table
paths: no slot, no claim, no lock, no file touched. Every table needs its own
seat — open its panel and use the session setup as usual. CONTRACT §1a2 has the
rules; `tests/test_tables.py` has them as assertions.

Regression replays over every debug recording (run them after touching the
reader): `tests/replay_status.py` (status rule + turn cross-checks; the
buttons column must stay 0), `tests/replay_cutover.py` (which line `/hand`
would carry; `BAD` must stay 0), `tests/replay_decisions.py` (every hero
decision through the live gates: how many would be HELD from auto-execute, and
why), `tests/replay_reconcile.py` (the reconciler against the archive). The
fake-table fixtures `btn-rfi-villain-sitting-out` and
`preflop-hero-3bet-field-reset` pin the hand-398 and hand-4919212912 cases in
the state suite.

## The hand fuzzer

    aof-model/.venv/Scripts/python.exe tests/fuzz_reconcile.py 3000

The fake TABLE renders one frozen spot — right for the DOM reader and the relay, no help
at all for the reader's DERIVATION, which consumes a tick STREAM and is where every bug
of 2026-09-19 lived. `tests/fake_hand.py` renders a scripted hand as ticks WITH the
client's real artefacts (a bet slot showing the chips added before the total; a FOLD
badge a tick behind the cards; a fold on the last tick before the deal; the pot label
lingering; chips swept after the board grows; cards blipping), and the fuzzer asserts the
line the reader derives equals the line that was played. It is tier 0 of `run_all.py`
because it needs nothing and a reader that cannot reconstruct a hand fails every tier
after it.

Every artefact carries the hand that proved the client does it. **Do not add one without
a recording** — an invented artefact tests fiction, and a generator that deals out of ring
order or stops a betting round early blames the reader for its own mistakes (that was 45%
of the first run).

## Test tiers (`tests/run_all.py`)

Four tiers, cheapest and most local first, so the FIRST failure is the cause.
A tier whose dependency is absent skips rather than fails.

| tier | asks | needs |
|---|---|---|
| `run_state_suite.py` | does an authored state export the right ParsedHand, and does the relay fire the right control | fake table |
| `reader_parity.py` | does the fake table lose anything the reader reads, replaying recorded REAL states | fake table + a recording |
| `spot_audit.py` | did the study tool solve the RIGHT spot (feed-spot's divergence audit) | + API on :2000 |
| `answer_suite.py` | did an answer actually arrive | + GTO Wizard signed in |

Two things the tiers deliberately do NOT assert. The answer's **pick**:
`rollAction` samples the mixed strategy with `Math.random()` per decision, so
pinning it builds a test that fails for the correct reason. And **money as a
string**: the client renders some readings without the BB suffix, so amounts
compare numerically.

`reader_parity` samples 120 of the corpus's ~1000 projectable states by
default (the full sweep is ~50 minutes); `--all` runs every one.

Known chart-coverage limits are declared per fixture under `expect.spot.known`.
They print on every run so they stay visible, never fail the suite, and DO fail
if they stop happening — which means either they were fixed or the fixture
quietly stopped reaching them. The headline one is the limped pot: no crawled
node offers a limp, so a limped line snaps to nothing and the answer has no
spot to stand on.

## Phases

1. ✅ this skeleton
2. live hand feed: CDP frames → OCR (`winocr`) / DOM → assistive-play
   `HandTracker` → large-print panel feed
3. Study Answers: gto-trainer (`localhost:2000`) verdicts in the panel —
   practice tables only, per the assistive-play bright line

Reuses `aof-model/scout/cdp.py` (Windows-validated) for all CDP access.
Env overrides: `IGNITION_URL`, `CDP_PORT`, `PANEL_PORT`, `CHROME_EXE`,
`TABLE_FRAC`.
