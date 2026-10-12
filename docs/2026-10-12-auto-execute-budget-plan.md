# Auto-execute: one session budget, Adjust on the panel, a confirm on every tick (2026-10-12)

BUILT on branch `claude/auto-budget` (worktree .claude/worktrees/auto-budget) during a live session — NOT MERGED,
tests and tsc NOT RUN yet (live session). Brady's answers: (1) practice AND real money bounded; (2) minutes count
only while auto is on; (3) one budget per table; (4) a declared auto + its budget is enough (no real-money box).
Adjust sets what is LEFT from now. Practice-armed auto still refuses to press on a real-money table (untick/tick).

## Before merging (between sessions)
1. `bun test test/unit/pick-relay.test.ts test/unit/study-auto-by.test.ts test/unit/auto-retry.test.ts` + full suite; `tsc`.
2. Contract recordings: `autoAllowance {granted, live}` unchanged on the fake rig; check GET /setup (setup.html changed).
3. Merge to main + WRAPPER RELAUNCH together (panel.html/setup.html are read per request — they go live on reload,
   the .ts side only on relaunch: merge only when no session is live, relaunch straight after).


## Brady's ask
- The auto-execute budget (minutes / hands) is set at session setup and shown on the panel (it is today, only for real money).
- The panel gets an **Adjust** button that opens the same budget editor as setup (minutes, hands, Max).
- The auto-execute checkbox loses the extra verification: ticking it ON or OFF is **one confirmation dialog**
  ("turn auto-execute on / off — budget X min / Y hands left?"), at the session's budget.

## How it works today (poker-wrapper main 431e92d)
- Setup (`ignition-study-wrapper/setup.html:168-190`): On/Off, timing, no-answer, and — ONLY under
  "allow it on a REAL-MONEY table" — the budget row `auto-min` / `auto-hands` / Max (defaults 30 min / 50 hands,
  clamps 1-2880 / 1-10000). Saved as `cfg.autoBudget`, `cfg.autoRealMoney`.
- Session start (`src/session.ts:792-800`): `autoDeclared*` seeded from the config; if declared, `setAuto(true,
  {allowReal, minutes, hands})` at once — so on real money the budget's CLOCK STARTS AT SESSION START, before a seat.
- `maybeAutoArm()` (`src/relay.ts:1070`) re-arms a declared auto later but passes NO allowReal and NO budget, so it
  only ever arms on practice.
- Budget = a real-money "test allowance" (`relay.ts:963-1068`): wall-clock `autoRealUntil`, hands counted from
  `S.handNo` at arming. Practice tables have NO budget at all.
- **Off throws the budget away** (`setAuto(false)` zeroes the allowance and clears `autoDeclared`); on again = new grant.
- Panel tick (`panel.html:1806-1826`): practice → arms plain, no confirm; real money → `confirm()` then a
  HARDCODED 240 min / 2000 hands, reason "unattended-path test" — ignores the setup budget. Untick: no confirm.
  Speech says "real money, thirty minutes" (wrong: 240).
- Panel display (`panel.html:1635-1663`): budget left shown only while real-money auto is live.
- Each table is its own wrapper process → its own `S.study`, budget and checkbox.

## Gaps against the ask
1. The panel tick ignores the setup budget (hardcoded 240/2000).
2. Off/on restarts the budget instead of continuing it.
3. Real-money clock starts at session start, not at seating / arming.
4. No budget on practice; no budget shown when auto is off; no way to change it mid-session.
5. Two different flows (practice: no confirm, real: confirm + grant; off: no confirm).

## Proposed design
**The budget is the session's, not the arming's.** `S.study.autoBudget = { minutes, hands, usedS, usedHands,
armedAt, armedHand }`, seeded from `cfg.autoBudget` at session start.
- Counts only while armed: ON stamps `armedAt/armedHand`; OFF folds the elapsed time / hands into `usedS/usedHands`.
  OFF no longer zeroes it — ON again continues with what is left.
- Runs out → disarm (as today, in `autoTableOk`), feed line + `study-auto` event `reason: "budget-spent"`.
  The checkbox can't arm with 0 left: the dialog says so and points at Adjust.
- **Applies to practice too?** — OPEN QUESTION (below).
- Real-money permission: the setup's "allow on a REAL-MONEY table" stays as THE permission for the session
  (it decides whether a declared auto arms by itself at real money); the panel tick's confirm IS the permission
  for a manual arm. `allowRealMoney` on `/study-auto` keeps meaning "this arm may be real money".

**Wrapper (`gto-trainer/apps/wrapper/src`)**
- `relay.ts`: `autoAllowance()` → `autoBudgetLeft()` from the session budget (`minutesLeft`, `handsLeft`, `live`);
  `setAuto(true)` arms against the session budget (opts.minutes/hands only when a caller sets a new budget);
  `setAuto(false)` accumulates instead of clearing; new `setAutoBudget(minutes, hands)` (clamped like setup; may
  be below what is used → 0 left → disarms on the next tick). `maybeAutoArm` passes `allowReal: autoDeclaredReal`.
- `server.ts`: `POST /study-auto/budget {minutes, hands, via}` (or `budget` on `/study-auto`); `contract.ts` Body.
- `view.ts:138-139`: expose `autoBudget: {minutes, hands, minutesLeft, handsLeft, armed}` (keep `autoAllowance`
  for the panel until it is switched over).
- `session.ts:792-800`: seed the budget; arm at session start without starting the real-money clock early — the
  clock counts from the first seated hand (or simply from arming, once the table is known real).
- Session events: `study-auto` carries `{budget: {minutes, hands, minutesLeft, handsLeft}}`; new `study-auto-budget`
  event for Adjust (who / old / new).

**Panel (`ignition-study-wrapper/panel.html`)**
- Budget line always visible while answers are on: "auto budget: 23 min / 41 hands left (of 30 / 50)" + **Adjust**.
- Adjust opens an inline editor: minutes, hands, Max, Save / Cancel — the same fields as setup.
- Checkbox: tick ON → `confirm("Turn auto-execute ON — REAL MONEY|practice — budget 23 min / 41 hands left?")`;
  tick OFF → `confirm("Turn auto-execute OFF? (23 min / 41 hands of budget kept)")`. Nothing else. Drop the
  hardcoded 240/2000 + reason; fix the speech.
- Declared-but-waiting / expired texts collapse into the budget line.

**Setup (`ignition-study-wrapper/setup.html`)**
- Move the budget row out of `auto-real-row` so it shows whenever Auto-execute is On (practice too, if that is the
  answer to Q1); keep the real-money checkbox beside it. Factor the minutes/hands/Max row into one snippet the panel
  copies (two static pages — copy, not shared JS).
- Summary line (`setup.html:574-576`) states the budget whether or not it is real money.

**Tests** (after the session): `test/unit/study-auto-by.test.ts`, `pick-relay.test.ts`, `auto-retry.test.ts`
(+ a new budget test: off/on keeps the remainder, Adjust below used disarms, spent refuses to arm, practice per Q1);
contract golden for the new endpoint / view fields. Not an answer-path change → no replay gate.

## Going live — careful
- **panel.html / setup.html are read from disk on EVERY request** (`server.ts:70` `page()` → `readFileSync(C.ROOT…)`),
  `C.ROOT` = the main checkout's `ignition-study-wrapper`. Editing them in `C:\Users\Brady\poker-wrapper` changes
  the live panel on its next reload, mid-session, against a wrapper process still running the OLD relay code.
  → Build on a worktree branch; merge only between sessions; the panel and the wrapper code must land together.
- The `.ts` side needs a WRAPPER RELAUNCH (between sessions).

## Open questions for Brady
1. Budget on **practice** tables too, or real money only (today practice is unlimited)?
2. Minutes = **time armed** (pauses while off) or wall-clock since the session's first arm?
3. Multi-table: one budget **per table** (today's shape, simplest) or one shared across tables (leader owns it)?
4. Should the declared auto still need the setup's "allow on REAL-MONEY" box, or does a declared On + budget suffice?
