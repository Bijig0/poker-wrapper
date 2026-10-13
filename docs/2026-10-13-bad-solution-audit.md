# Bad-solution audit — 2026-10-13

**Question.** Where can the player be shown, or have pressed, an answer that is wrong for the spot, without anything
saying so? Hand 4923635257 (row 16058) is the model case. The pool cold-call lock timed out, and QQ was answered on the
plain tree, where the SB's cold-call is 0.10% of his range (traps). It was told **Fold 77%**. Every check passed, the
verdict was "by design", and the fold was auto-pressed 0.4 s later.

## 1. The auditor was calibrated first

- **Brief:** one standard brief (taxonomy, method, deliverable), saved in the session scratchpad as `audit-brief.md`.
- **Blind run on the pre-fix code:** the auditor ran it on a detached checkout at **475fef5** (before any fix), with data
  cut off at 2026-10-10 05:00. It was not told about the bug.
- **Result:** it ranked the cold-call-lock timeout as **#1 critical**, with row 16058 as its example. It also explained,
  unprompted, why check #3 passed it.
- **One miss, and the fix:** it called the badges safe; on that code, the failed lock showed the lock's own badge. The
  brief now requires tracing every label through the code that builds it before calling it safe.
- **The same brief then ran on current main (5335162) in four areas** — preflop, postflop, display/press, pool ranges —
  plus two targeted reviews: the preflop failover, and the in-product checks.

## 2. Built — on branches, NOT merged (Brady 2026-10-13: "don't merge anything, let me know first")

Both are in worktree `C:\Users\Brady\poker-wrapper-wt-fr`.

### `claude/failover-review-fixes` (50461e8)
A review of yesterday's preflop GTO Wizard failover:
- A re-post is bounded by the read's clock. A hung re-post used to run a 30 s read to about 48 s, and a locked chain to
  about 90 s.
- A re-post never lands back on an account the chain has already left.
- The gate for locked chains is now realistic.
- An existing replacement is reused whatever time is left.
- Aliases are followed through the whole chain, including when forgetting a walled solve.
- The auth round is reset on an account switch.
- A locked parent's locks are kept in the chain.
- A mid-read re-post is said on the answer: path reason `preflop:solve-reposted`, amber banner.

Tests: 5 new, 14 in all.

### `claude/unsafe-answer-guard` (4298008, built on the branch above) — the "never again" net
- **A failed lock is a FAILED path reason.** Codes `preflop:pool-limp-lock-failed` / `-coldcall-lock-failed`; this also
  holds on chart answers. Before, it was warning text only.
- **A pool lock lost at the flop is recorded on the arrival** (`arrival:pool-lock-lost`).
- **Check #3 (preflop) flags RESIDUE by node share alone** (<1% of the villain's range), whatever single hands do.
  - Before: share <1% *and* no hand above 2%, which passes traps.
  - It now runs on every AI preflop answer (before: 51 of 5,509 answers) and on every 6-max chart answer (before: never).
  - The pass text no longer contradicts its numbers.
- **Check #2 flags RESIDUE** when a villain holds under one combo on the street.
- **`services/unsafeAnswer`: an answer is UNSAFE when it has any of:**
  - a failed or lost lock;
  - hero absent from his own range;
  - a RESIDUE #2 or #3 flag;
  - a villain mistake line on the decision street;
  - a failed input/output check: #2, #4–#8, #14–#17. Slow or costly checks (#9–#13) never count.
- **The wrapper holds an unsafe answer.**
  - The panel shows a red **UNSAFE ANSWER** box with every reason, spoken once.
  - Auto-execute presses the *solved* pick when the base clock reaches 6 s, before fold-on-no-answer's 4 s. It never
    waits into the time bank: with the bank already running it waits 3 s; with no readable clock, 8 s at most.
  - The pick is never changed.
  - Off switch: `UNSAFE_HOLD=off` (shown red, pressed at once).
- **Expected rate:** roughly **7–9% of answers** marked unsafe. On 3 weeks of stored data, 179 of 3,093 postflop answers
  and 18 preflop, plus the new chart and AI #3 coverage. That is how often answers are read against a residue model
  today, and the root-cause fixes in §3 bring it down.
- **Gates:** API 2,661 pass / 0 fail; wrapper 370 pass / 0 fail; tsc known-2. Replay gate vs 5335162 PASS on
  2026-10-12 (348 decisions) and 2026-10-10 — no served decision changes.
- **To go live:** merge, then relaunch the wrapper (the API and panel reload by themselves).

## 3. Findings — root causes, still OPEN (ranked)

These are what make answers unsafe. Each one changes answers, so each needs your go, then a replay gate.

| # | Finding | Evidence | Proposed fix |
|---|---|---|---|
| 1 | **Postflop: a villain mistake line on the decision street.** The soft range only reaches *later* streets; hero's node is read against the solver's sliver, while the badge says "replaced". | 151 answers / 131 hands, **12% of postflop answers since 10-08**. 14206: A♣A♦ told **Fold 99%** to a 0.06% check-raise. 14382: QQ folded 99.5% to a 0.42% lead. | Node-lock that action at the soft range when it is on the decision street (`OFFTREE_LOCK` for this case). The guard now holds these. |
| 2 | **Menu F / re-tree dilute the played size**, so a common bet becomes a 0.06% "size". | 77 of 120 decision-street lines (64%) are diluted, not real mistakes. 13730: BET 5.7 at 0.70% beside BET 4.3 at 28.6%. | When the action as a whole is ≥1%, pin the played size alone at that level, and judge off-tree by action, not size. |
| 3 | **Chart walk snaps a villain's raise onto a size his chart barely uses.** | 14 chart answers since 10-05. 13446 / hand 4923399329: CO 3-bet 9.2 read at R9 (0.14% of his range; R7.5 holds 8.18%). **A♥T♥ served Fold 99.77%; the R7.5 node says All-in 99.13%.** | Read the dominant sibling size when it is inside the gap gate's bound, else refuse so the exact tree answers. The guard now flags these. |
| 4 | **Multiway blend takes the minimum per bet size, not per total aggression.** | 6 of 186 blends served aggression >15 pp under every tree. 11706: a **straight flush told CHECK 84%** (trees bet 100 / 100 / 77%). | Minimum over total aggression (maximum over fold), split by the trees' mean size mix. Not caught by the guard — fix it. |
| 5 | **Deep (>85bb) lone limper gets no pool range.** Hero answers vs the solver's 0.1–0.6% limp. | 85 answers since 10-05. 13614: HJ KTo **Fold 100%** vs a 93bb UTG limp; 14551: BTN KTo Fold 99.86%. | Extend `poolLockTarget` to `limp_first_deep` / `overlimp_deep` (the pool's 3.1% cell); send chart lines facing a deep limp to the locked tree. |
| 6 | **The 1% bar keeps the solver's range at 1–2% when the pool plays the spot 20–35×.** | SB flat cell 36.5% pool: solver 1.06% kept → hero bet vs 14 combos (15861, 15880). | Replace under max(1%, pool rate / 3), as the cold-call lock does; or `POOL_TRIGGER_DIVERGENCE=ignition` for Ignition-counted cells. |
| 7 | **Call tables have no premium cap** (AA at weight 1.0 in flat ranges, ~8× Ignition's rate). | 46 of 320 flat cells, 32 of 238 over-call cells. | The v4 premium cap or per-class Ignition calibration when rebuilding. |
| 8 | **BB iso-call / limp-call ranges ignore the iso size.** | 16237: a min-iso at 6:1 got the normal-iso range (108 combos). | Key by iso size / pot odds; outside the measured band keep the walked range. |
| 9 | **Pin-cap overlay gives a caller who then called a squeeze his whole flat range.** | 16325: HJ 0.46 → 260 combos after calling a 3-bet. | Skip `calledLater` (as the flat floor does). |
| 10 | **A refused raise / all-in ends as a fold** (fold-on-no-answer after the retries). | 3 live: 7828, 7890, 8532. | Never fall to FOLD after a refused aggressive pick: press CALL if offered, or hold and say "press it yourself". |
| 11 | **A verdict landing after hero acted is logged and shown as served.** | 7883, 10111 (123 s); 11 rows. | Clear `lastProbeKey` on not-to-act ticks; log as abandoned-stale. |
| 12 | **The pool limp lock is decided against a chart that then refuses**, so preflop and flop disagree. | 13645, 13907. | Re-run `poolLockTarget` with `chartId=null` when the AI tree answers. |
| 13 | **≈ chart answers are all verdict "clean"**; missing-tree fallbacks are unregistered. | 3,037 of 4,456 chart answers since 09-30. | By-design codes per approximation; register the fallback. |
| 14 | **Smaller items:** note parser stops at the "·" inside AI source ids (26 answers); cold-call key prefers stack band over size; the flop floor and the preflop lock use different bars; the limp floor ignores a later 3-bet call; the panel shows the previous decision's pick for up to 3 s; leftover roll text; "LIMP 4-BET FITTED" badge on every AI fit; the caller-cap page shows the real line not the borrowed one; the hand page reads today's bake, not the served mix; a memo-hit rebuilt arrival reads clean; collapses and re-roots carry no path code. | See the agents' reports in the session. | Small fixes, batchable. |

**Checked and safe** (across the six reports):
- pick vs mix, one roll per decision, pressed action type (8,846 of 8,883 confirmed; NL200 sizes exact);
- wrong-hand and wrong-table guards;
- hero-absent fail plus passive pick;
- pot seatbelt; size-snap check #6;
- lock bodies (sum to 1, the right action, held-check);
- pool keys recomputed by hand (stack as dealt, 3-bet ratio, jam side/depth);
- gap-gate / fit-empties failures coded and badged;
- chart server and solve cache keys.
