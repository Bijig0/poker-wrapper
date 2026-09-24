# Input-mutation harness: overnight fix report (2026-09-25)

Branch `worktree-agent-a957233375dc38b44`, based on `zenbook-main` 1d69d714. Twelve commits by the overnight
worker (Opus) plus this report, nothing pushed. Every fix came from a harness finding, was traced to a root cause,
and has a test that fails without it. Independently re-verified by the supervising session: `tsc` clean apart from the
two pre-existing `_replay…729` scratch scripts, gate 24/24, full suite 723 pass / 24 skip / 2 fail (both need files
under `data/` the worktree does not have: `resolved-charts.json`, `mes_turn`), and a fresh 300-seed / 300-pair sweep
on unseen seeds 20001..20300 (result appended at the bottom).

## Numbers

| run | cases | hero decisions | findings |
|---|---:|---:|---:|
| before: seeds 1..300, 300 pairs (first deterministic run) | 5,700 | 7,892 | 366 |
| after: seeds 1..300, 300 pairs, all 18 operators (`missed-fold` is new) | 6,000 | 8,383 | 0 |
| after: fresh seeds 301..1300, 1,500 pairs | 19,500 | 27,305 | 0 |
| after: fresh seeds 1301..4300, 4,000 pairs | 58,000 | 81,986 | 0 |
| after: fresh seeds 5301..10300, 6,000 pairs | 101,000 | 141,578 | 0 |

- Gate (`MUTATION_GATE=1`, `mutationHarness.test.ts` + `mutationHarness.fixtures.test.ts`): 24 pass, 0 fail.
- `bun test`: 723 pass, 24 skip, 2 fail (hrc3max NL25 needs `data/resolved-charts.json`; mesPostflop turn needs `data/mes_turn`).
- `tsc --noEmit`: only the pre-existing `_replayFlopRoot729.ts` / `_replayStreets729.ts` errors.

## Operator matrix, single operators (ok / cloud-gated / expected-refusal / finding)

| operator | before | after |
|---|---|---|
| baseline | 406/11/0/0 | 411/6/0/0 |
| board-short | 303/0/89/0 | 305/0/85/0 |
| dead-sb | 0/491/0/0 | 0/493/0/0 |
| deep-seat | 383/9/0/3 | 395/3/0/0 |
| dropped-call | 239/41/50/93 | 239/5/215/0 |
| dup-card | 298/0/99/0 | 301/1/93/0 |
| hero-deviates | 375/18/0/67 | 387/74/0/0 |
| jam | 362/31/0/1 | 359/39/0/0 |
| late-fold | 309/0/0/71 | 383/1/0/0 |
| limps | 304/39/0/86 | 463/7/0/0 |
| missed-fold (new) | 314/0/0/76 on first run | 390/0/0/0 |
| nl25-rounding | 396/7/0/7 | 408/1/0/0 |
| nl5-rounding | 393/16/0/2 | 406/8/0/0 |
| odd-3bet | 378/25/0/4 | 386/8/0/0 |
| odd-open | 377/17/0/4 | 384/3/0/0 |
| short-seat | 385/30/0/6 | 413/17/0/0 |
| stack-drift | 385/6/0/1 | 390/0/0/0 |
| thin-table | 258/132/0/0 | 273/120/0/0 |
| unlabelled-seat | 56/0/415/0 | 56/0/417/0 |

The hands differ between columns because the generator fixes change what gets dealt. `hero-deviates` cloud-gated rose
because off-pick lines now go to the AI tree instead of being refused.

## Pipeline classes fixed

1. `dropped-call`, 95 corrupt captures answered. Cause: nothing compared chips with the line. Fix: `lostActionFaults` in `captureFaults` checks (a) this round's `committed` vs the round's actions, (b) a seat acting later with an unmatched earlier round, (c) the table pot vs closed-round chips + this round + antes (0.6bb slack). Test: `utils/repairPostflopRotation/lostActions.test.ts`.
2. `late-fold`, 71 postflop capture-faults. Cause: the preflop gate repaired late folds, the postflop path did not. Fix: `repairPostflopCapture`. Test: same file.
3. Fitted pin, seed 111 [limps]: the folded-out limper's later call was handed to the HJ. Fix: per-seat fitted reads; hero on his pinned node + action; the resume checks its seats against the capture; `fittedRangesBySeat` shared with `recon6max`. Test: `services/preflopPin.test.ts`.
4. Line past the tree's caps after hero's decision, seed 93: the unpinned fallback moved hero's node. Fix: resume falls back to per-seat reads. Test: same file.
5. Hero off the pick, seeds 144, 1865: each answer records hero's mix; `heroDeviation()`; flop ranges from the AI tree ("OFF THE CHART (hero's own line)"); preflop no-cell cases go to the AI piece. Test: `preflopPin.test.ts` heroDeviation.
6. Caller-cap borrow, seeds 589/981/1237/842: the pin named the real node while the pick came from the donor. Fix: pin records the donor node + folded seats; later decisions `foldSeatsOut` ("LINE KEPT AS THE HAND WAS READ"). Test: `utils/fitLine/fitLine.test.ts` + fixtures.
7. Chart switch in limped pots, seed 1231: equilibrium chart for the iso, pool tree for the next decision. Fix: no cell in the pool tree → re-read on the earlier chart ("CHART KEPT"). Test: fixtures.
8. Fit folded the caller hero's earlier decision was read with, seeds 2593/3992/3935. Fix: retry with those callers protected (`walkFitted protect`, `borrowHeroCall keep`), else the AI piece. Test: `utils/borrowHeroCall/borrowHeroCall.test.ts` + fixtures.
9. Short jam read as all-in for the whole depth, seed 1333: flop refused "near all-in". Fix: `preflopPotStack(…, allInTo)` uses the capture's jam sizes; the jammer leaves the rotation. Test: `utils/aiStudyLine/aiStudyLine.test.ts`.
10. Silent wrong answer, seed 2053: a 25bb jam was mapped onto the chart's 2.5bb open (verdict "ok"). Fix: a jam mapped onto a non-all-in action more than 2x away is refused and the exact tree answers; the node's own All-in is accepted at any size. Test: fixtures.
11. All-in player as a live flop seat, seed 1333. Fix: dropped from the tree while 2+ players can act; chips stay in the pot; the villain pick skips him. Test: `scripts/mutationHarness.oracle.test.ts` + fixtures.
12. `missed-fold`: the "reached the flop with no preflop action" rule fired on every missed fold; later-orbit missed folds shifted tokens onto the wrong seat. Fix: the rule fires only for a seat that plays on; later-orbit folds are written into their slot ("FOLDS NOT CAPTURED"). Test: `lostActions.test.ts`.

All 12 classes have replay seeds in `scripts/mutationHarness.fixtures.test.ts` (20 cases, gated).

## Generator / harness changes

1. `Math.random` seeded per case (findings now replay).
2. `liveHand()` applies `withStartStacks` like the live `resolveHand`; `stack-drift` is now inert for seats with start stacks, as it is live.
3. The BB now gets his option in limped pots.
4. "Limp" picks are calls.
5. "All-in" picks are the whole stack.
6. Corruption is judged against the benign-only export.
7. Export operators apply in a fixed order.
8. Zero weight after a cloud-gated preflop decision counts as cloud-gated.
9. New operator `missed-fold`.
10. Stricter oracle: a postflop dry run must match the dealt pot and flop seats (`FastSolveResult.dryRun`, `inputMismatch`).
11. `scripts/mutationRepro.ts` replays one finding.

## Deferred to Brady (live behaviour, veto-able)

1. Deviation → AI tree. Seeds 144 and 1865 [hero-deviates].
2. CHART KEPT. Seed 1231 [odd-open].
3. Mis-mapped jams refused, about 4% of jam decisions, so more GTO Wizard calls. Seed 2053 [jam].
4. Posted blind (Ignition btn 8) refused as a lost action; 2 of 888 archived hands. Wrapper should record the post (the other session is adding exactly that: a poster's check read as a limp, flagged approximate).
5. Pot ledger 0.6bb slack, checked only against end-of-hand archive pots.
6. A lost call by a seat that folds later or hasn't acted postflop can pass live without a reliable pot reading. Wrapper should export current per-seat WebSocket chips.
7. Preflop all-in player dropped from the flop tree; main-pot showdown not modelled.
8. Keeping earlier callers can send the decision to the AI piece. Seeds 2593 [thin-table], 3935 [limps+odd-3bet].

## Not verified

- No GTO Wizard calls were made; AI-piece paths show only as cloud-gated.
- The oracle checks pot and seats, not ranges or sizes.
- Live precision of the pot ledger and the posted-blind refusal needs a live session.

## Independent verification (supervising session, unseen seeds)

`--seeds=300 --pairs=300 --seed0=20001`: 6,000 cases, 8,352 hero decisions, **0 findings** (33 s). Gate 24/24. Suite 723 pass / 24 skip / 2 data-dependent fails. tsc clean apart from the two pre-existing scratch scripts.
