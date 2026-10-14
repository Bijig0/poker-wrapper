# 2026-10-14 — a "hung poll" is a running solve: the hedge, routing by solves in flight, the late lock's fallback

**The hand.** session_20261013_223500, hand 4924409679, KsJd on 2c Kh 4d 5h 6h. Hero bet 15.8bb on the river, villain
raised to 42.2bb at 00:40:54.6 (+07), the API never answered, the time bank (taken 00:41:10.5) ran out at 00:41:56.4 and the
client folded. The first diagnosis (2026-10-13) was "GTO Wizard stalled on both accounts for a minute". Brady did not believe
it, and the ledger agrees with him.

## What actually happened

- **GTO Wizard holds a node read of a solution that is still solving.** It never answers 204 for "not solved yet": ledger
  9-28..10-14, 93 polls sent before a solution's first 200 — 0 × 204, 93 "hung" (our 8 s cap, `GTOW_POLL_HANG_MS`). A hung
  poll is a solve slower than 8 s, not a lost request.
- **It was not an outage.** Inside the minute, 22/22 tree + solution POSTs to the same host answered in 0.3-0.8 s and 18
  polls answered 200. Across the 36 hang bursts of the last two weeks: 318/318 POSTs ok, 156/610 node GETs hung. Same host,
  same minute, reads only — their solver tier, not the site, not our network (Ignition's socket delivered frames on both
  tables all minute; the event loop never stalled over 448 ms; no Wi-Fi event).
- **GTO Wizard queues an account's custom solves.** 5,334 solves: POST → first node median 2.3 s when the account has no
  unanswered solve of ours, 4.5 s when it does; slower than 8 s: 7.1% vs 23.7%.
- **That minute, per solve:** ultra-2 2700e2a7 (the fixed river tree) posted 0.4 s after table 1's turn solve → root 10.6 s;
  primary f7e21599 (the re-post) 11.1 s; primary 2a920ee3 (table 1's flop) and 99c98760 (the OFFTREE_LOCK child) posted while
  f7e21599 still ran → never answered in 21 s / 11 s. f7e21599's hero node arrived at 00:41:45.5, 11 s before the fold, unused.
- **Our part:** the 2026-10-08 re-post threw a running solve away at 8 s and started cold elsewhere; each attempt had a 12 s
  read; attempt 3 posted a third cold solve (the lock child) onto an account already running two, with no fallback.

Measured at the hang (4 s left of a 12 s read): keep polling the solve 43.5%, a cold re-post ~64%, both ~80%. Hung polls
are chronic — 259 of ~19,000 since 9-28, 36 bursts over 10 play days; this minute was the worst (16 in 84 s).

## What changed (poker-wrapper, `claude/hung-hedge`)

1. **The hedge** (`gtowApi.hedgeSolution` / `adoptSolution` / `hedgeSibling`, `aiChain`): a walk read of a solve that has run
   `GTOW_POLL_HANG_MS` (8 s) without serving its root, with a cold tree's cost still on its clock, comes back `hung`; the
   walk keeps polling that solve on a fresh node clock AND posts the same tree on another account; the first node to answer
   wins and is adopted for the rest of the hand. The poller's next attempt races the same pair (no third solve). Trace: leak
   `tree:hung-hedge`, span "hedge after a hung poll", log `[gtow-hung] … hedged on another account`.
   `GTOW_HUNG_HEDGE=off` restores the 10-08 re-post.
2. **Routing by solves in flight** (`gtowSessions.noteSolvePosted / noteSolveReady / inFlight`): inside a routing group the
   account with no solve of ours still running comes first, then the trailing-hour count. `[gtow-route] … least-loaded (no
   solve of ours running on it); … solves in flight: primary 1`. `GTOW_ROUTE_INFLIGHT=off` restores the 10-08..14 order.
3. **The late lock's fallback** (`offTree.offTreeLockFallbackOn`, `aiChain`): a failed read on a node-locked child (late,
   hung, any error but a wall) is answered from the unlocked parent on a 4 s clock (its node is usually prefetched). Trace:
   `offTree.soft.lock.late`, leak `lock:late-parent`. `OFFTREE_LOCK_FALLBACK=off` restores 10-13.

Gates: tsc (the 2 known `_probePostflopNodeLock` errors only); aiChain.hedge (10) + gtowSessions.inflight (7) +
gtowApi.hedge (5) new, 248 existing in the touched suites; replay gate session_20261013_223500 vs aa40346 PASS, 0 decisions
differ; live check `src/scripts/_hedgeLiveCheck.ts` (cap 1.5 s, 2 boards): hedge posted on the idle account both times, once
it won and was adopted, once the first solve won.

## What to watch

```
grep -c "hedged on another account" gto-trainer/apps/api/data/jobs/api.log
grep "hedge after a hung poll\|tree:hung-hedge\|lock:late-parent" gto-trainer/apps/api/data/jobs/api.log | tail
```
Good: hands that would have timed out now answer (the hedge wins some, the first solve wins some). Bad: hedges posted on
every street of a quiet night (the trigger is too eager — raise `GTOW_POLL_HANG_MS`), or an account walled (429) because the
hedges doubled its hour — watch `[gtow-requests]`.
