# 2026-10-14 — three-seat trees took 10-35 s: the hedge storm, and four fixes that leave every answer alone

**The session.** session_20261014_161508 (16:15-17:24 +07, two tables). Brady: "multiway postflop spots e.g. 73o all took
wayyy too long". Hand 4924571722 (7d3h, BB, UTG + CO + SB limped): flop 16.7 s, turn 13.7 s, turn facing a 3.8bb bet
34.8 s. The other 3-way limped pots the same: 4924571783 15.3 s / 33.9 s, 4924572514 16 s with NO answer then 5.6 s,
9.9 s, 26.0 s; 4924570880 14.8 s. Heads-up postflop was normal.

| decisions by tree size | n | p50 | p90 | max |
|---|---|---|---|---|
| 2-seat trees | 37 | 3.6 s | 6.4 s | 12.3 s |
| 3-seat trees (3-way pots, 4-way collapses) | 12 | 14.8 s | 33.9 s | 34.8 s |

Every earlier session of the last 14 days had a 3-seat p50 of 4-7 s (the worst 11 s).

## What happened (api.log `[slow-answer]` + solves.trace + the gtow_requests ledger)

1. **GTO Wizard's three-seat solver was slow that hour.** Solve 09568455 took ~29 s with ONE solve on its account;
   93f08b28 13 s, ec79152d 15.5 s. The cold three-seat median is 6.3 s (p90 11.5). Our side of the wire was fine: no
   event-loop stall over 0.5 s, POSTs answered in 0.3-0.8 s.
2. **The hung-poll hedge (f836713, live 03:39 that morning) fires at 8 s** — about the normal three-seat p70. Under a slow
   solver it fired on 29 trees in the session (25 of 274 polls hung; 1-5% before). Each hedge is another cold three-seat
   solve on the OTHER account, which then queues and hangs itself (GTO Wizard solves an account's trees in turn: >8 s
   share 7% idle vs 24% busy). Hand 4924571722 needed 8 trees and posted 18 solves; across both tables 24 solves went up
   in two minutes for two decisions' worth of hands.
3. **The warm-up and the live walk double-hedged.** They read the same solve, hang on it within 3 ms, and both called
   hedgeSolution; hedgeSibling only knows a hedge once its POST has returned. The ledger shows four tree POSTs within
   50 ms at 17:10:45. One tree was solved three times (40290dee on ultra-2, ff1335cf + 1ab50cf7 on primary).
4. **All three collapse trees of the 4-way flop went to one account.** Routed within 50 ms, every one saw an empty
   ultra-2 (a solve counts as in flight only once its POST has returned; the +5 reservation did not close a 9-request gap)
   and the third fell back to it because primary's token was not in hand at that instant. Three in flight on one account
   from a single decision.
5. **Facing a bet in a 3-way pot the chain runs two cold three-seat solves in series**: the size-free tree lacks the
   wager → fixed-size re-tree (+ hang + hedge), 4-5 sequential node reads (1-2 s each at three seats), then the off-tree
   node LOCK posts a child solve (the villain's bet was 0.45-0.72% of his range): its POST alone took 10 s (789534eb) and
   its node 8 s more. 34.8 s = 13 s re-tree + 4 s walk + 18 s lock.
6. **A hung lock child was "hedged" with the UNLOCKED tree** (81227e90, hand 4924571783): hedgeSolution posts the street's
   tree input, not the lock. Had that solve's node won the race, the hand would have been answered from an unlocked tree
   while the trace said locked. This time the child answered first; the hedge was a wasted cold solve.
7. The 15 s three-seat node clock expired once (4924572514 flop: gtow-timeout, no answer; the poller's next attempt got it).

## What changed (poker-wrapper `claude/multiway-slow`) — timing and load only, no answer changes

1. **One hedge per hung solve** (`gtowApi.hedgeSolution` → `hedgePending`): a second caller hanging on the same solve
   while the first's hedge POST is on the wire joins that POST (`created: false`, why "joined the second solve another
   read of this solve posted"); the trace's treeWhy says "this read joined the hedge another read posted".
2. **A hedge goes only to an idle account** (`gtowApi.hedgeIdleOnlyOn`, `gtowSessions.idleFor`): a hung walk read comes
   back `hung` (and the walk hedges) only while some account other than the owner has NOTHING of ours in flight — trees
   just routed included; otherwise it polls its solve on to the clock, exactly as a read with too little time left always
   did. Log: `[gtow-hung] … — no idle account to hedge on (solves of ours in flight: …): polling on`.
   `GTOW_HEDGE_IDLE_ONLY=off` restores the 03:39-18:00 behaviour.
3. **A routed tree counts as in flight at once** (`gtowSessions.noteTreeRouted`, called from noteRouted; replaced by its
   solve on noteSolvePosted, forgotten after ROUTED_MAX_MS = 5 s): the trees of one decision routed in the same instant
   spread over the accounts instead of all seeing an empty one.
4. **A node-locked child is never hedged** (`aiChain`): a hung read on the child is polled on, on a fresh node clock
   (step "the locked solve is slow → waiting for it"); a child still late then falls to the unlocked parent as before
   (lock:late-parent). Trace: `offTree.soft.lock.slow = { ms, answered }`.

Not changed, on purpose: the 8 s cap itself, the fixed-size re-tree on an off-menu wager, and the off-tree lock — the
last two are accuracy choices (accuracy over upfront cost), and with the storm gone the cap only costs one extra solve
on an idle account.

**Why the answers do not move:** a hedge is the same tree solved on another account, and the code already adopted
whichever answered first; routing changes which account solves a tree, not the tree. The degradations slowness caused
(a collapse dropped from the blend, a 15 s no-answer, a lock child answered from its unlocked parent) become rarer.

## Gates

- tsc: the two known `_probePostflopNodeLock` errors only.
- Tests: gtowApi.hedge (+5), gtowSessions.inflight (+3), aiChain.hedge (+2) new; gtowApi.hungPoll updated (a `hung`
  needs an idle account with a live token and a clean in-flight count); 98/98 across the 10 touched suites.
- Replay gate: session_20261014_161508 vs b17e2d7 → PASS, 0 decisions differ from the control.

## What to watch after the next session

```
grep -c "hedged on another account" gto-trainer/apps/api/data/jobs/api.log
grep -c "no idle account to hedge on" gto-trainer/apps/api/data/jobs/api.log
grep "joined the hedge another read posted\|locked child polled on" gto-trainer/apps/api/data/jobs/api.log | tail
```
Good: hedges rare and only when the other account is idle; no tree solved three times (ledger: solutions per hand ≈
trees per hand); 3-seat decisions back near p50 5-7 s when GTO Wizard is itself normal. Bad: "no idle account" on
every three-seat hang while answers still run past 15 s — then GTO Wizard is slow across the board and only a third
account or a longer clock helps.
