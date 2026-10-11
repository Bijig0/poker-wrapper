# Time boxes and silent fallbacks: review of 2026-10-10

**Trigger.** Hand 4923635257 (dashboard hand 6591, action 8). The SB cold-called a 3-bet. The pool cold-call lock timed
out at 12 s, so QQ was answered on the UNLOCKED tree, where the SB's call is 0.10% of his range. The answer was Fold 77%.
The hand page still showed the lock's badge. The lock's own solve finished late and is now in the cache: it reads
Raise 20 / All-in 80. In a week, 5 of 6 live cold-call locks timed out.

**Bug family.** A time box, network error or refusal silently hands hero a less correct answer, or the UI shows a step
as applied when it was not. Brady's rule (2026-10-10): a time box that trades accuracy for time is a bug. Ignition gives
15 s plus a 45 s time bank, and the bank starts itself at 0.

Four read-only scans were run: answer-path time boxes, mislabelled departures, network/error fallbacks, and the wrapper
side.

## Fixed — merged to poker-wrapper main (`claude/pool-lock-40s`, merges 92979fd + aa12b4a)

| What | Was | Now |
|---|---|---|
| Pool locks: cold-call, limp, hero self-lock (`POOL_LOCK_MS`) | 12 s, borrowed from `GAP_GATE_AI_MS` | 40 s, its own setting |
| Limp lock | ran BEFORE the plain answer (40 s + 5-12 s) | runs beside it; the lock's pin is put back afterwards |
| Gap gate / fit-empties exact tree (`GAP_GATE_AI_MS`) | 12 s | 40 s |
| Re-root narrowing (`REROOT_NARROW_MS`) / last-resort narrowing (`LAST_RESORT_NARROW_MS`) | 10 s / 6 s | 30 s / 20 s |
| Reduced-tree caller read (`REDUCED_READ_MS`) | 12 s | 30 s |
| Poller → fast-solver abort | 45 s | 55 s |
| Late exact-tree answer served after the chart also failed | not pinned (no tree record; the flop resumed from an older pin) | pinned |
| Failed lock / gate on the hand page | the departure's badge, as if applied | red FAILED chip, the reason, every seat labelled "GTO range" (register `failWarn` / `failCodes`, `departureState`) |
| `departuresReport` | counted failures as firings (cold-call lock: "6", of which 1 applied) | "FAILED: N" listed separately |
| "NOT NARROWED" match | case-insensitive (3 false RE-ROOTED badges) | `warnCase` |
| Pool-floored flop seats on the hand page | 61 of 143 labelled "GTO range" | every floored seat: arrival `poolSeats` + the answer's POOL … RANGE notes |
| Hero range as answered: a read failed or threw | single fit kept, no note | note on the answer |
| Re-tree note | left out the "miss" nodes | says "NOT narrowed as answered: …" |
| Wrapper: a press the table never registered | `executed` set → the clock rule stood aside → hero timed out | the clock rule acts at its normal moment |
| Wrapper: one unreadable clock tick | fired the 30 s backstop | estimated from the last readable clock |
| Wrapper: bank start whose jump frame was unreadable | missed (bank counted twice) | a clock past 15 s is taken as the bank |
| Poller: call-amount flicker | a second full solve (a second 40 s lock) and the first verdict dropped | one solve per decision (street/board/cards/actions) |
| Chart server: R2 fetch failed | HTTP 200 "unknown solution", cached as "no such line" for the life of the process | 500 → retried → "unreachable" |
| A collapse that could not be walked | warning only (verdict could read "clean") | `postflop:collapse-dropped` (failed), FAILED on the page |
| Pool-locked pin not resumable at the flop | rebuilt as the plain tree, nothing said | "POOL … LOCK LOST AT THE FLOP:" |
| handFacts read threw | a fresh doc written over the stored row (pin and stacks lost) | row left alone |
| GTO Wizard timeouts and 429s in no-answer reasons | classed "unknown" | `gtow-timeout` |
| A preflop fit read failed (network) | silently left out of the blend | retried once; logged `[fit-read] FAILED` |

**Gate.** API suite: 2,524 pass, 0 fail. tsc: the 2 known errors. Wrapper suite: the same as main (6 stale goldens).
Replay gate on session_20261010_042118 vs 475fef5: PASS.

**WRAPPER RELAUNCH OWED** for the wrapper half: relay.ts, state.ts, ignition/reader.ts, ignition/dom.ts. The API and
chart server restart by themselves.

## Open — not fixed (ranked by gameplay impact)

1. **Postflop node read cap: 12 s heads-up, 15 s 3-way** (`gtowApi.ts:46`, `THREEWAY_NODE_TIMEOUT_MS`). Corrected
   2026-10-12 after tracing every live case: a timeout fails ONE attempt, and the poller re-asks at once. 14 of the 16
   live postflop timeouts in 3 weeks were answered on the re-ask, 10-35 s into the turn (one CoinPoker hand took 44 s).
   The 2 never answered (4923628100, 4923632605) were network drops: the GTO Wizard poll failed and the table socket
   stalled and closed, so both sessions ended. Fold-on-no-answer was OFF in both. A 30 s cap would only save a re-ask on
   ~0.6% of postflop decisions. LOW priority; Brady's 10-08 caps stay.
2. **The API does not know hero's remaining time bank.** A lock now waits up to 40 s. With a partly spent bank, the
   wrapper can fold at its 4 s mark while the unlocked answer has been ready since ~5 s. Fix: the poller sends the
   clock + bank left; locks and gates wait `min(box, left − 8 s)`.
3. **Preflop GTO Wizard failover — FIXED 2026-10-12** (poker-wrapper `claude/preflop-gtow-failover`, merged to main).
   A tree / solution POST whose request fails moves on to the next account; a poll that hangs (no reply in 8 s) or a
   429 on the owning account re-posts the solve — tree, solution, locks — on another account when a cold tree fits what
   is left of the read (`GTOW_PREFLOP_REPOST_MS` 10 s + 3 s a lock), the replacement answering for the old solution id;
   with no time left after a 429 the tree's memo is forgotten so the next ask posts afresh elsewhere; a failed lock POST
   is sent once more. Log tags `[gtow-route]`, `[gtow-hung] … preflop solution`, `[gtow-preflop-repost]`. Measured
   before: 11 of 902 live preflop AI answers with a hung poll, 2 at 35-40 s, 1 past the cut-off (hand 4923636936).
   CHECK after the next sessions: `[gtow-preflop-repost]` lines — how many rescued, any "NOT re-posted".
4. **fitAiLine / reduced tree: a network error reads as "the line is not offered".** The arrival goes to the reduced tree
   and the cause is erased (`gtowAiPreflop.ts` 1313, 2842, 2970, 3245-3314). Fix: return `{error}` distinct from "no
   fit"; fail with `arrival:read-failed`.
5. **Stale solves are never cancelled.** An abandoned 40 s lock keeps a poller slot (max 2) and spends GTO Wizard budget
   (`studyPoller.ts:599`, `routes/fastSolver.ts:195`). Fix: pass an AbortSignal through.
6. **Session option "time bank: Leave it" folds at the +45s offer (~9 s on the clock)** (`relay.ts:1226`). Slow answers
   now rely on the bank (and it starts itself). Remove the option, or make it wait to 4 s.
7. **A one-tick blip wipes a held answer and restarts the solve** (`studyPoller.ts:539-543`: hero briefly not to act, a
   failed ingest, the GTO Wizard check). Keep the answer unless street, board, cards or action count changed.
8. **The no-answer fold reason does not name the upstream cause** (API down, poller timeout, stale answer). Also, any
   future "progress" note pushed without an answer would fold every decision (`relay.ts:1223`).
9. **Fit reads that still fail after the retry** are logged but not shown on the answer.
10. **Minor:**
    - the cold-call lock's NOT NEEDED verdict appears only in the log;
    - check #3's villain lines can be silently empty (`VILLAIN_LINES_MS`);
    - SB-flat v2 keys an unknown VPIP band when `seatHistoryFor` throws;
    - an unknown solver share is recorded as `pool-limp-lock-skipped`;
    - `aiChain.answeredHeroNode`: a store read that throws is not recorded as a miss;
    - random auto-delay vs the clock (the default is instant).
