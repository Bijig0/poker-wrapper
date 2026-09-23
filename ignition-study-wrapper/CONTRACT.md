# Wrapper ⇄ gto-trainer contract

The Ignition study wrapper (this directory, port **7700**) and the gto-trainer
API (port **2000**) talk over four HTTP interfaces. This file is the single
source of truth for their shapes; both sides link here. The wrapper implements
the same live-feed protocol as assistive-play's `RemoteControl`, so
gto-trainer's `resolveHand`/`studyPoller` work against either server unmodified
(consumer: `gto-trainer/apps/api/src/feed/resolveHand/resolveHand.ts`,
`services/studyPoller.ts`).

## 1. `GET :7700/state` — live game state (poller → wrapper, 1 Hz)

Consumed by `resolveHand({ live: true })`. Contract fields (extra keys are
fine — the wrapper also keeps its legacy `cdp` / `ignition` / `targets` keys
for the panel's own connection badges):

```jsonc
{
  "connected": true,          // false → poller reports "no table detected" (409)
  "studyAnswers": false,      // the panel's Study Answers toggle — THE gate:
                              // while false the poller idles and pushes null
  "hand": { … } | null,       // current hand, ParsedHand shape (§1a); null between hands
  "snapshot": {
    "status": "…" | null,     // free-text table status for error messages
    "seats": [ { "hero": true, "sittingOut": false } ]   // hero row only is enough
  }
}
```

### 1a. `hand` — ParsedHand shape

Normalized by `feed/normalizeHand` (forgiving: missing bookkeeping fields get
defaults). Invariants the wrapper guarantees at the export boundary:

| field | shape | invariants |
|---|---|---|
| `handId` | number | wrapper-local counter |
| `heroSeatId` | number | client seat number (face-up cards identify hero) |
| `heroCards` | string[] | `"A♠"`-style; ranks use **`T`, never `10`** |
| `board` | string[] | same card rules; 0/3/4/5 entries |
| `street` | `"preflop"\|"flop"\|"turn"\|"river"` | derived from board length |
| `actions` | ParsedAction[] | in true action order, blinds included |
| `actions[].type` | `post-sb\|post-bb\|fold\|check\|call\|bet\|raise\|all-in` | |
| `actions[].amount` | number (BB) | **raise/bet = the seat's round total** ("raises to"), call = the top-up; omitted until the BB scale is known |
| `positions` | `{seatId: pos}` | gto-trainer vocabulary only: `UTG/UTG1/UTG2/LJ/HJ/CO/BTN/SB/BB` — short tables fill **button-backwards** (5-handed = HJ CO BTN SB BB) |
| `stacks` | `{seatId: bb}` \| absent | from DOM labels; trusted only with an explicit "BB" suffix or a known blind size |
| `committed` | `{seatId: bb}` | this betting round |
| `currentNode` | node | `toActSeatId`: hero when ANY of the three turn signals says so (§1b); `pot`/`toCall` in BB |
| `ended` | boolean | hero folded ⇒ true |
| `buttonsUp` | boolean | the client's turn buttons (with an amount) are on screen right now |
| `toActSources` | `{buttons, ws, actionOn, wsAt, timeBank}` | the three independent views of hero's turn (§1b) |
| `heroStatus` | `in-hand\|folded\|not-in-hand\|sitting-out\|waiting-for-bb\|unknown` | levels before words: a hero who was dealt / holds cards is never sitting out |
| `notToActWhy` | string \| null | when `toActIsHero` is false: `hero folded` / `hand won` / `status …` / `action on seat N` — the poller writes it as a `not-to-act-live` failure row if the buttons stay up 2 s |
| `lineSource` | `ws\|reconciled` | whose betting line `actions` is (§1c) |
| `lineUncertain` | string \| null | set while a reconciler fault is LIVE on this street (§1c); the poller passes it to the panel as `uncertain` and auto-execute holds — a pause, re-tested every tick, that lifts itself |
| `lineNote` | string \| null | informational: what the reconciler changed when its line was taken |

### 1a2. Several tables (2026-09-19)

Ignition allows four tables at once. Four tables are four wrapper PROCESSES sharing
one browser — not one process with four of everything: the reader is module-level
state that presses buttons with real money, and the failure mode of sharing it
across tables is "acted on the wrong table's state".

| | |
|---|---|
| slot | `TABLE_SLOT` 1-4 in the environment; unset = the single-table setup, which takes none of these paths |
| panel | `PANEL_PORT` 7700 / 7710 / 7720 / 7730 (`apps/wrapper/src/tools/runTables.ts`) |
| browser | ONE `--user-data-dir` ⇒ one Chrome process, one login, ONE `CDP_PORT` shared by every slot |
| window | one app window per slot, CLAIMED by Chrome targetId (`tables.py`, `data/tables/<slot>.json`) |

A CLAIM is how two wrappers never read the same window. CDP returns targets in no
particular order and a reloaded window moves within the list, so ordering alone
cannot assign them. A claim is refreshed on every read and expires after
`CLAIM_TTL_S`, so a wrapper that dies frees its window and a restarted one takes
it back. A slot whose window is gone reports NO TABLE rather than borrowing
another's — reading the wrong table is worse than reading none.

Claims are on the WINDOW, not the table: at startup the windows are lobbies, and a
Chrome targetId survives navigation, so one claim holds from lobby through sitting
down and every reload after. `tables.pin` therefore takes a RANK (which pages are
candidates, and which are preferred) rather than being called once per preference
tier — asked about table pages alone, a slot still on the lobby would not find its
claim in that narrower list and would claim a seated slot's window.

`/hand` carries `tableSlot` and `panelPort`; `/state` adds `tables` (every slot's
claim, with a live flag) for the overview strip. `handId` is a per-process counter
and collides across tables — `clientHandId` and `tableSlot` are what attribute a
hand. Answers carry `table_slot` (answers.sqlite).

PRESSES ARE SERIALIZED across tables (`tables.press_lock`). CDP injects input per
TARGET, so simultaneous clicks are not two hands on one mouse; what they share is
VISIBILITY, because Chrome parks synthetic input on a hidden page and
`Page.bringToFront` for one window can hide another's. Tiling the windows is the
real fix and the lock is the belt to its braces. A press is never DROPPED for want
of the lock: a wait that times out presses anyway and says so (`pressLockForced`),
because hero is on a clock and a missed press costs a hand.

On the API side there is ONE POLLER PER WRAPPER, keyed by `assistiveUrl`
(`studyPollers`). Keyed rather than listed on purpose: two pollers on the SAME
wrapper double-answer a decision and can roll two different actions for it. Each
wrapper registers itself, so the wrappers need no knowledge of each other. Solving
does not serialize behind this — `gtowApi` is HTTP with in-flight coalescing, so
four tables solve in parallel over one token and one cache.


#### Tiling, and why it is correctness (2026-09-20)

The windows are TILED, by CDP rather than by window handle. Every table window
carries the same title, so the title match that finds the panel cannot tell slot
1's felt from slot 4's — with a slot set, `_wrapper_windows()` refuses to return
a table at all, and `launch.place_my_table()` moves the window holding this
slot's CLAIMED targetId (`Browser.getWindowForTarget` + `setWindowBounds`), which
is this table's window by construction. `setWindowBounds` speaks logical (DIP)
pixels while `monitors()` and `MoveWindow` speak physical ones; the rect is
scaled by the DPI of the monitor it is going to.

Geometry is pure, in `tables.table_rect` / `panel_rect` / `grid`: one table keeps
the old 70/30 rectangle to the pixel, two split into columns, three and four tile
2×2 — the fourth cell is left EMPTY at three tables so adding the fourth never
moves the ones already in play. Panels tile the other screen. The layout is
computed from the DECLARED `TABLE_COUNT`, never from how many slots happen to be
live, so a slot that dies and restarts finds its own cell instead of reshuffling
the felt mid-hand.

A window narrower than `TABLE_MIN_W` (800 CSS px) is reported as `narrow: true`
on `/state.layout` and `/layout`, and shown on the panel. This is not tidiness:
measured 2026-09-20, a table at 640×376 reads perfectly — 253/253 state-suite
assertions — and lands NONE of its clicks, because the action buttons fall
outside the viewport. A silently missed press is the worst failure this code has,
so the size is a fact the panel can see. The fix is the MONITOR's scaling, not
the app's: the external was moved from 200% to 100% on 2026-09-20, which turns a
2×2 into four 1280×776 tiles (each page 1264×737 CSS px, against 896 for the
single-table setup that has always worked).

PHYSICAL PIXELS ARE NOT THE BROWSER'S. `monitors()` measures physical pixels;
Chrome places windows in DIP, each monitor divided by its own scaling. On a
MIXED-DPI desktop the origins differ too: a laptop at 200% taking physical
0..2880 takes DIP 0..1440, so the screen beside it starts at DIP 1440 while its
physical origin is 2880. Dividing the absolute coordinate by the destination
monitor's scale put the right-hand column of tables at DIP 4160 on a desktop
ending at 4000 — off the edge, producing no frames. Chrome parks synthetic clicks
on a page that is not rendering, so two of four tables could not be pressed at
all; the relay refused them with "the table window is not rendering" rather than
missing silently, which is how it was found. `tables.to_dip` carries each
monitor's ORIGIN as well as its scale, and `tests/test_tables.py` pins it against
this exact desktop.

#### One session, several tables (2026-09-20)

Brady declares a session ONCE, on the LEADER's setup page, and every other live
table joins it. Until this, each wrapper declared its own: four open rows in
sessions.sqlite for one sitting, four opening balance readings on one account,
and a dashboard that saw four sessions of sixty hands instead of one of 240.

| | |
|---|---|
| how many | config `tables` — **1, 2 or 4**, chosen on the setup page. Three is not offered: the tiler splits a screen into halves or quarters, so three costs every table the smaller window and leaves a quarter empty |
| leader | slot 1, by definition not election — it launches the browser, so it exists whenever anything does (`tables.is_leader`) |
| declare | `POST /session/start` on the leader: it becomes table 1 of N (`tables.adopt`), re-tiles its own window, SPAWNS the others (`_open_tables`), then `_fan_out`s the join in parallel |
| join | `POST /session/join {sid, config}` — follower adopts the id, applies the config, records `table-joined`. NO session record, NO balance reading |
| leave | `POST /session/leave` — follower stands down and records `table-left`. The RECORD is the leader's to end |
| end | `POST /session/end` on the leader fans out `/session/leave` FIRST, then takes the closing balance |

THE COUNT IS A SESSION DECISION, not a command-line argument. A wrapper starts
as it always did — one table, no slot, none of the claim/lock/tiling code — and
`tables.adopt(n)` makes it table 1 of N at Start, because `slot()` reads the
environment on every call. Ending the session closes the extra tables and adopts
1 again, so the next session chooses its own count instead of inheriting one.
`runTables.ts N` (gto-trainer/apps/wrapper/src/tools) still works and brings N up front, which is what the test rig
wants; the setup page is the way you do it for real.

`/layout/preview` tells the setup page what each count would give BEFORE you
commit to it, so a choice that cannot be pressed in is visible next to the
choice rather than discovered with a session running.

A follower's `/session/start` is REFUSED and its `/setup` redirects to the
leader's: one setup page, or the thing this replaced comes back. A follower opens
its `/panel`, not a setup page. A table that stands down RELEASES its claim
rather than leaving it to expire.

The other tables stand down before the closing balance is read, because that
reading brackets the session's hands — a table still playing would move the
account between the reading and the record, and the dashboard would flag our own
doing as unexplained movement (see `services/profiles.ts`).

`sessions.event()` holds the write lock across its whole read-append-write
(`BEGIN IMMEDIATE`). It is a read-modify-write over a JSON column and four
wrappers append to one session at the same instant: without it the last write
wins and the others vanish — four tables joined and one `table-joined` was
recorded, 2026-09-20. Pinned in `tests/test_session_events.py`, which runs the
writers as separate PROCESSES because that is what the tables are.

ONE PLACE WENT AROUND THE CLAIMS AND IT COST A DAY OF FALSE CONFIDENCE.
`_faketable_load` picked the FIRST `/faketable` target on the CDP port instead of
this slot's claimed window, so with four tables up every follower's fixture load
reloaded the LEADER's page: table 1 passed the state suite 15/15 while tables 2-4
sat frozen on a stale spot and scored 8/15. Testing only table 1 had hidden it.
The rule the claims exist for has no exceptions — `ignition_target()` is how a
slot names its own window, everywhere.

#### Every table's answer on one tab (2026-09-20)

`GET /tables` on the leader returns one card per table — whose turn it is, the
answer we gave, the window size — collected over loopback from each peer's
`/state?light=1`. The panel cannot do this itself: each table is a different
ORIGIN, so the browser would need CORS on four servers to draw one strip. A table
that does not answer inside the timeout is shown as unreachable rather than
holding the strip up. The leader's own card comes from the same state its big
answer card does, so the strip is never a second opinion about the table you are
sitting at.


### 1a3. Nothing about a live hand is final (2026-09-19)

The reader's conclusions are HYPOTHESES while the hand is still in front of us. Three
layers, because prevention alone will never be complete — the client keeps inventing
new transients:

1. **Settle before committing.** Any conclusion drawn from a value that can still move
   must see it twice. The client renders the amount ADDED in a bet slot for a tick
   before the new total, so a raise to 9.2 from 2.5 reads "6.7" first and a call of 5.2
   reads as a DROP. Rising levels were already coalesced; `_swept()` now requires the
   whole table to clear before a drop counts as a sweep, and the told-vs-did check
   (§2a) needs a size twice before it will call a press wrong.
2. **Retract when contradicted.** `_revive()` — `ended` used to be set in six places and
   cleared in none, so one bad tick blinded the reader until the next deal. A hand that
   shows hero's turn buttons, or a board that has grown, is not over; the reader resumes,
   retracts a fold it INFERRED for hero, and re-anchors its ledger to the chips on screen
   (carrying the old one forward reports a pot mismatch the reader caused itself). Every
   revival is recorded in `rc.revivals` and surfaces in the shadow record. Across the
   recordings this fires on 22 of 244 hands and recovers actions on 16 — the reader had
   been quietly ending ~9% of hands early.
3. **Re-ask only when something changed.** The poller re-probes every tick, which is
   worth nothing when the input is identical: hand 4919236052 asked the same
   unanswerable question 13 times and got the same sentence back. The same
   (decision, reason) is now asked `REPEAT_FAIL_LIMIT` times and then RESTED — no solve,
   and the panel is told (`/state.panelNote`) instead of showing a blank card. Any change
   to the key or the reason re-arms it at once, which is what layer 2 now produces.

### 1a4. Observation before judgement (2026-09-19)

`HandReconciler.observe()` does two different things, and they must not be entangled:

* **_tally() — bookkeeping.** How many ticks a seat has shown no cards, how many it has
  shown a FOLD badge, and which street its fold evidence first appeared on. Runs on the
  FIRST line of every tick, before any early return.
* **everything else — judgement.** Needs `live`, `acted`, the ledger; may legitimately
  bail out (not armed yet, the street's chips have not cleared, the hand looks over, the
  pot is being swept).

The counters used to live at the BOTTOM, below all of that. Those exits fire on exactly
the ticks that matter — street boundaries and pot awards — so a seat folding in one of
those windows had its counter frozen and its fold recorded a street LATE. That put an
action in the wrong street's tokens, and for a seat not in that street's tree at all the
walk died on `"Fold" not walkable at FLOP#1`, taking every postflop decision in the hand
with it (hand 4919261748, dashboard #489). A fold is also stamped with the street its
evidence was first SEEN on (`hold_street`, keyed to the SEAT — cards-gone and the FOLD
badge arrive a tick apart, and re-stamping on the second puts the street back), and a
late fold does not imply checks, because this street's action order says nothing about an
earlier street's fold.

Measured over every recording, postflop actions filed for a seat the table had already
shown out: 20 hands -> 6, and only 4 of those are real (all in recordings that predate
several reader improvements).

### 1b. Hero's turn — three signals, cross-checked (2026-09-19)

1. `CO_SELECT_REQ` on the table WebSocket — the client asking THIS player to
   act (buttons bitmask, bet/raise, time bank). Cleared by hero's own
   `CO_SELECT_INFO` or a `CO_CURRENT_PLAYER` for another seat.
2. The client's action buttons on screen (`_TABLE_JS`, `buttonsUp`).
3. `CO_CURRENT_PLAYER` (`actionOn`).

`toActIsHero` is true when (1) says so, or (2) with real action in the hand
past the deal grace, or (2) held for a full second, or (3). Every tick the
wrapper compares them (`_state_check`); a disagreement held for ~1 s is a
`state-check` session event + feed line + `/state.stateHealth` entry, once
per decision. Hero's status words (`SITTING OUT`, `I AM BACK`, `Waiting for
big blind`) are captured PER SEAT by the DOM reader and only count for hero
when hero was not dealt and holds no cards.

### 1c. The betting line — event log vs level reconciler

`actions` is the event log's line (WS frames + DOM backfill) unless the level
reconciler (`reconcile.py`, fed every tick) derives a different line AND its
derivation was clean: then the reconciler's line is exported (`lineSource:
reconciled`, `lineNote` says what changed, `committed`/`toCall` come from its
ledger). A reconciler line that is a strict prefix of the event line is the
reconciler lagging (it holds folds/presses 2-3 ticks) and the event line stands.

**Two questions, two answers (2026-09-19).** They used to share one flag, and
each one was wrong for the other:

* *May the derived line REPLACE the log?* Only if the reconciler broke no
  invariant anywhere in the hand. Scoping this to the current street let a hand
  whose preflop CALL was derived a blind short be archived from the derived line
  because its only violation happened later, on the flop.
* *Must auto-execute HOLD right now?* Only while a fault is still true — see
  `HandReconciler.faults()`. A fault stays live while its condition keeps
  re-asserting (every tick's check refreshes it) and for `FAULT_TTL` ticks
  after; a missed action (`seat skipped while owing`) never clears, because no
  later tick repairs a line that skipped a seat. Holding on the whole violation
  log instead meant one flickering tick — the previous hand's chips in a seat
  whose cards had not landed — disabled the relay for the rest of the street
  with no way back. Across every recording that was 21 of 209 hero decisions;
  it is now 7, and every one of those is a live disagreement about money.

A derived line the reconciler could not read at all (its line opens outside the
blinds) is *not* evidence against the event line: the event line is kept, a
`lineNote` says so, and nothing is marked uncertain.

## 2. `POST :7700/panel/answer` — answer push (poller → wrapper)

Body `{ "text": "PREFLOP — Raise 2.5 63% · Fold 37% · roll 81 → FOLD",
"pick": "Fold", "roll": 81, "note": null }` or `{ "text": null }` to clear.
`pick` is the RNG-sampled action for mixed strategies (the panel headlines
it); `roll` is the 1-100 sample, `null` when the spot is pure (pick = the
~100% action). `note` is the solve's own caveat (snapped sizes, generic
ranges) — the panel shows it under the answer so the verdict's trust level
is visible. All three are optional — assistive-play's original panel reads
only `text`.
The wrapper stores the push with a timestamp; the panel shows it only while
the toggle is on **and** the push is fresher than `STUDY_ANSWER_TTL_MS =
3000` — so a dead poller degrades to a blank card, never a stale verdict.
The poller re-pushes the unchanged answer every tick while the spot stands
(keep-alive), repeating the SAME pick/roll — a decision is rolled once.
`/state.panelAnswer` mirrors the gated answer as `{text, pick, roll} | null`.

Since 2026-09-13 the push also carries `decisionKey` (the poller's own
`[street, board, heroCards, toCall, nActions]` JSON) and `handId` (the
wrapper's hand counter as the poller saw it). They are what the wrapper's
pick→relay path checks before it acts (§2a); a push without them is shown
but can never be executed. Since 2026-09-19 it also carries `uncertain`
(the export's `lineUncertain`, echoed back): while set, the panel shows it
under the answer and auto-execute holds (`study-auto-held` session event);
a manual press still works.

### 2a. Pick → relay (wrapper-local; `POST :7700/act/pick`, `POST :7700/study-auto`)

The rolled pick can be sent to the table through the same relay a panel
press uses. `POST /act/pick` (no body) executes it — the panel's pick button,
Enter or Space. `POST /study-auto {on}` arms execution WITHOUT a press; it
only arms on a practice-money table (the client's `playMode=fun`) or the fake
table and answers 409 otherwise. Either way `/state.pickReady`
`{ok, reason, plan, key}` has to say ok: answers on, a fresh pick (≤ TTL),
hero on the clock (turn buttons up), hand not over, and the pick's
`handId`/`decisionKey` still describing the table (same hand, street and
action count). One execution per hand+decision. A sized raise/bet is typed
into the client's bet field and read back; a clamped value is refused, not
pressed. `/state.practice` and `/state.studyAuto` report the gate and the switch.

**A press is not an outcome (2026-09-19).** The relay returns "ok" when the
click dispatches — a claim about our side of the wire. Hand 4919212912 typed
10.5 into the bet field, read it back as 10.5, and the client had reset the
field to its 4 bb minimum by the time RAISE took the click: a 3-bet six and a
half blinds short, recorded as a clean success and invisible until the hand was
graded offline. Every press now carries a POSTCONDITION, checked on the feed
loop (`_maybe_verify_exec`) against the table's own chips — hero's action must
appear at the action index the decision key names, and be the action that was
sent. `/state.pendingExec` is a press still being watched;
`/state.lastExec.outcome` is the verdict:

| `outcome` | meaning | what follows |
|---|---|---|
| `confirmed` | hero's action is the one that was sent | nothing — the send line already said it |
| `diverged` | hero acted, but not as told | loud on the feed and in `pick-outcome`; never retried — the chips are already in |
| `unknown` | nothing arrived before the deadline | loud; the attempt budget is spent |
| `abandoned` | the spot stopped being hero's before anything landed | noted, not an error |

A retry runs only on PROOF that nothing landed — `_spot_unchanged`: hero still
on the clock, no notice over the strip, the same hand, street and action count.
Deliberately not `_pick_ready`, which also wants answers on and the pick fresh;
neither bears on whether a press that never registered may be sent again. Poker
actions are not idempotent and hero is on a clock, so the budget is
`VERIFY_ATTEMPTS = 2` presses at `VERIFY_DEADLINE_S = 2.5` each, and the
fallback is to tell the human rather than keep pressing.

A shove is sent through whichever control the client offers it on: the action
row's ALL-IN, else the SIZING row's (`allInSelector`) followed by the
confirming RAISE/BET. The two rows stay strictly separate (`_split_strip`), so
this is an ordered fallback, never a guess.

#### 2b. Real-money testing allowance (2026-09-14, temporary)

`auto` normally arms only on a practice table or the fake table. The practice
tables never had enough players to deal a hand, so the unattended path could
not be exercised at all; `POST /study-auto {auto:true, allowRealMoney:true,
minutes, hands, reason}` grants a bounded exception on a real-money table.
Bounds: `minutes` (clamped 1–120, default 30) AND `hands` since the grant
(clamped 1–500, default 50), whichever runs out first. `_maybe_auto_act`
disarms `auto` and writes the reason to `lastExec` + the session record the
moment either budget is gone. Never a default, never inherited by a session,
always dropped at session end. `/state.autoAllowance`
`{granted, live, minutesLeft, handsLeft, handsUsed, reason}` is what the panel
counts down; without `allowRealMoney` a real-money arm is still refused 409.

Declared at setup (2026-09-14): the session config carries `autoExecute`,
`autoRealMoney` and `autoBudget {minutes, hands}` (sessions.py
`merged_config`; the setup page's Settings step). `_apply_session_config`
applies the declaration at Start and `_maybe_auto_arm` keeps trying each feed
tick, so a declaration made before any table exists arms as soon as a table it
is allowed on appears. The declaration is an INTENT, not a bypass: declared
without `autoRealMoney`, a real-money table still refuses and the panel says
"declared at setup, waiting". The LIVE panel toggle always wins — turning it
off clears the declaration, so it is not re-armed on the next tick — and an
allowance that ran out is never re-granted by the declaration.
`/state.autoDeclared {on, realMoney, budget}` is what the panel reads.

## 3. `POST :7700/study-answers` — the toggle (panel → wrapper)

Body `{ "on": true|false }` → `{ "ok": true, "on": … }`. Mirrored into
`/state.studyAnswers`. This local switch is the single control: the poller
reads it every tick and does nothing (no GTO Wizard navigation, no CDP
traffic) while it's off.

## 4. Audit interfaces (Feed section)

- `GET :7700/hand` → `{ ok, hand }` — the same ParsedHand as `/state.hand`,
  standalone for tooling.
- `POST :2000/api/feed-spot` `{ hand }` → `{ ok, actual, shown,
  discrepancies[], warnings[] }` — the observed table beside the solved
  config actually used, every divergence named
  (`gto-trainer/apps/api/src/routes/feedSpot.ts`).

## 5. `GET :2000/api/study-poller/status` — health (panel → gto-trainer)

`{ running, gtoWizardConnected, lastError, lastAnswer, lastPushAt, … }`.
The panel polls this to paint the toggle badge: `ON ●` healthy, `ON ⚠ <reason>`
when the poller can't deliver (GTO Wizard down, feed unreachable, …).

## Ports

7700 wrapper (assistive-play-compatible) · 2000 gto-trainer API ·
8777 solve-DB server (3-max asym preflop charts — run
`analysis/pipeline/solve/exploit_ui/server.py`; 3-handed preflop answers
degrade to the 6-max tree, loudly flagged, when it's down; the 6-max RING
charts do NOT use it — they are baked into gto-trainer's
data/hrc6max-preflop.sqlite, so a ring session's preflight checks the bake
rather than this port) ·
9222 GTO Wizard CDP · 9333 Ignition browser CDP (9223 = CoinPoker's, avoid).

The wrapper's `hand.bbCents` (big blind in wire cents, once the blind post
calibrates the scale) is what selects ign200 vs ign500 charts 3-handed;
absent → ign200.
