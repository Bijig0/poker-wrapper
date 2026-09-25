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

## Round 2 (2026-09-25): the range-level oracle, golden ranges, live checks, post-in / undealt-seat

Branch `worktree-agent-a2e2c937c1f8f1b59`, reset to round 1's tip (6b3e05db), zenbook-main merged four times (e5d4cdd8
post-in + undealt seat, c44326c9 roll logic, bc74cfcf with the wrapper post-in commits, 2fdcb0ba fold-on-no-answer clock);
the branch contains zenbook-main at 2fdcb0ba. 19 fix commits (20 classes), 8 harness / tooling / report commits, 4 merges;
nothing pushed. Every fix has a test that failed first (a unit test, or for chart-level
classes a replay seed in `mutationHarness.fixtures.test.ts`, as round 1 did).

### The oracle layers added (`scripts/mutation/rangeOracle.ts`, `referenceRanges.ts`, `goldenRanges.ts`)

The postflop dry run now reports the solver input itself (every seat's class range, the 1326-combo arrays of each tree,
the preflop tokens, the street tokens and their seats, the rake), and `reconstructFlopRanges` has a walk recorder (off
except in the harness) so the oracle sees every step every walk took.

1. **Layer 1, invariants (no reference).** `hero-combo-zero` (hero's combo in the array the tree is built with),
   `range-widened`, `jam-on-raise`, `step-action-mismatch` (a range conditioned on an action the seat did not take),
   `size-past-tolerance` (τ), `size-snap-unreported` (the note must name THAT size, "HJ's 2.6bb read as 2.5bb"),
   `range-provenance` (each seat's input range is the output of a recorded chart walk), `range-product` (the chart's own
   per-class frequencies along that walk, nodes read afresh, reproduce the weights), `tree-range-mismatch`. Added while
   sweeping: `postflop-line-mismatch` (street tokens vs the dealt actions: exact sizes, RAI only for a raising all-in,
   seats), the stack behind (effective dealt stack less the preflop price, heads-up, nobody all-in), `rake-cap` (by
   players dealt), `fold-free-check` (hero posted in, faces nothing, answer says Fold), `piece-routing` (<= 3 dealt
   answered from the 6-max charts; 4-6 dealt with both blinds sent to the AI piece as "thinned").
   Sanity: a range bug injected into reconstructFlopRanges was caught (range-product), a disabled villain-size merge
   showed as range-mismatch.
2. **Layer 2, the reference walker.** An independent walk of the SAME baked chart on the DEALT line (the generator's
   actions, never the capture): no fitting, no borrowing, no pin, the nearest offered size, the documented villain-size
   merge, an all-in that does not raise the price is a call, a posted-in player's check is a limp (the documented
   approximation). A seat's difference beyond 0.02 is a finding unless the answer names an approximation FOR THAT SEAT
   (`explainsSeat`: "X with Y folded", "X: … borrowed", hero's own fitted/kept line for hero only, a different chart or
   "these ranges are read on that line" for all). Every excused difference is written to `explained.jsonl`. Also for
   preflop: hero's node against the reference's (`preflop-node-mismatch`). Own tests: `referenceRanges.test.ts`,
   `rangeOracle.test.ts` (31 pass).
3. **Layer 3, golden ranges.** For every archived Ignition 6-max hand with a stored chain trace (main checkout's
   `data/solves.sqlite`, read-only), today's solver input (hero's preflop decisions replayed so the pin is set as live,
   then the postflop decision dry) against what GTO Wizard was sent then, and against the hand's LATEST stored solve.
   37 golden hands, 10 identical today; judgements below. It caught one regression of my own (fix 10).

### Finding classes: root cause, fix, test

| # | class (seeds) | root cause | fix (commit) | test (failed first) |
|---|---|---|---|---|
| 1 | size-past-tolerance (50 [jam]) | flop range walks snapped any distance; after the AI answered hero's next decision offline the flop resumed the older chart pin and read the BB's 3-bet to 10 as 6.5 (0.43 > τ) | `reconstructFlopRanges` maxSnap (SNAP_TAU in the 6-max walks), refused and named; pin resume / recon6max refuse (19282d52) | reconstructFlopRanges.test "sizes moved onto the tree", preflopPin.test past-τ |
| 2 | size-snap-unreported (5, 6, 27 [nl5]; 44 [base]; 3 [stack-drift]) | ranges read at 2.5 for a 2.6 open, 9 for 8.75, 23 for 25, unsaid | walks return `snaps`, the pin records `sizeSnaps`, note "PREFLOP SIZES SNAPPED onto the chart: …" (19282d52) | same + preflopPin.test snaps note |
| 3 | range-mismatch (1669 [short-seat], 1559 [odd-open], 1130 [thin-table]) | a caller-cap-borrow pin whose per-seat fits failed was read by the pinned walk on the FITTED codes, note silent (UTG KK 0.53 vs 0.007) | the note names the fit: "…and these ranges are read on that line" (5a6178bb) | preflopPin.test "a fitted pin whose per-seat fits fail" |
| 4 | preflop-node-mismatch (2328 [jam]) | every all-in tokenized RAI: a 25bb SB calling a raise to 25 became the chart's jam to 30, hero answered facing a 5-bet that never happened (postflop and the AI line too) | `allInCalls`: an all-in that does not raise the price is C everywhere (1e8d1f67) | feed/buildSolutionUrl/allInCalls.test |
| 5 | hero-combo-zero (2807 [hero-deviates]) | classWeightsToSpec writes 4 decimals: hero's 92s at 1.6e-6 became "92s:0" in the tree | a positive weight writes as >= 0.0001 (4725e5eb) | reconstructFlopRanges.test "never serialises as zero" |
| 6 | solver-input-mismatch, pot (86 [base]) | MY regression of 4: an all-in call for less (now C) counted at the full price (293 vs 290.5) | preflopPotStack `allInCallBySeat` (3bb19c75) | aiStudyLine.test "an all-in CALL token (C) is capped" |
| 7 | capture-fault (post-in: 214 in 300 seeds; 1, 2) | the gate read a pending or folded post (folded out of the line by foldPostIns) as a lost action | the ledger counts pending/folded posts (ab629d5b) | lostActions.test "posted-in players" |
| 8 | pot (post-in 8) | a folded poster's dead post missing from the flop pot | `deadPostsBb` added to the flop pot (c92c1926) | foldPostIns.test deadPostsBb |
| 9 | piece-routing 64, rake-cap 92 (undealt-seat 1, 5) | routing and rake counted labels: 3 dealt + a sitting-out label went to the charts as 4-handed; the rake cap one player high | `utils/dealtSeats`; is3/is6Handed, `sixMaxRakeCapBb`, last-resort rake (ef4e669d) | fastSolve.dealtSeats.test |
| 10 | golden 4919260843, 4919958663; piece-routing (undealt-seat 2) | MY regression of 9: a dead button (the BTN label sitting out, five dealt) sent to the AI piece | count decides the piece, labels the tree's shape (1fbb5fb4) | fastSolve.dealtSeats.test "a dead button" |
| 11 | pot (post-in+missed-fold 412) | a poster whose fold was lost stayed "pending" at the flop: post left out of the pot, note "is yet to act" | past the preflop a pending poster is a lost fold: dead post, note says so (998d139e) | foldPostIns.test |
| 12 | answered-corrupt-capture (unlabelled-seat+post-in 199, 11636) | an unlabelled pending poster is invisible to the UNLABELLED ACTOR rule (his post is folded out of the line) | captureFaults checks postIns (4a4c6bb2) | lostActions.test "a poster with no position label" |
| 13 | postflop-line-mismatch (232 [missed-fold], 213) | a seat whose preflop fold the tap lost counted live in the postflop rotation; hero's own turn check dropped as a phantom | out of the rotation once the preflop was played (17594600) | repairPostflopRotation.test "a missed preflop fold" |
| 14 | hero-zero-weight preflop (14999 [short-seat]) | chart changed under hero (the short BTN folded) and CHART KEPT hit a pruned 3-bet branch: ok answer, no decision | refused, named "CHART CHANGED UNDER HERO", the AI tree answers (9a4a2309) | fixture 14999 |
| 15 | stack behind (85 [missed-fold], 22 [undealt-seat]) | dealtEffective took the deepest "not folded" opponent: a lost-fold seat or a sitting-out label set the depth (99 vs 94) | `seatsInHand` (5cd3dfca) | services/hrc6max.dealtEffective.test |
| 16 | postflop-line-mismatch (15564, 17644 [missed-fold]) | 13 missed a BLIND's lost fold: his post counted as an action | `lostPreflopFold`: posts are not decisions; the BB of an unraised pot keeps his check (bee755bc) | repairPostflopRotation.test blind case |
| 17 | hero-zero-weight flop (18287 [short-seat]) | the pinned chart could not hold a 5th entrant after hero's squeeze; the flop re-picked a chart where hero never squeezes | a resume failure after the prefix matched is `chartCannotHold` → the AI tree (89ef0991) | preflopPin.test chartCannotHold |
| 18 | postflop-line-mismatch (21901 [jam]) | a player all-in preflop counted in the flop rotation; the HJ's check dropped as a phantom | all-in on an earlier street is out of the rotation (9a002555) | repairPostflopRotation.test all-in case |
| 19 | stack behind (27266 [missed-fold]) | the postflop depth was pinned from the RAW capture, before the repair wrote the BTN's lost later-orbit fold (91 vs 89.2) | repair first, depth from the repaired hand (7895064d) | fixture 27266 |
| 20 | answered-corrupt-capture (triples 27947, 30764) | lost-call rule 2 skipped any seat that ever folded; the SB's lost complete (0.5-0.6bb, inside the pot slack) was answered once he folded the turn — round 1's deferred item 6 | a folded seat is judged on its non-fold actions (204e980d) | lostActions.test "folds later" |

Tooling: chainReuseStress snapshots carried the archive's end-of-hand pot, which round 1's pot ledger refused on every
later street (7b85b664); `HANDS_DB` override; sampled operator triples `--triples=N` (1c1f3c59). Archive scan for fix 20
(`_archiveGateScan.ts`, 955 hands / 1,253 hero decisions): 2 hands newly refused — 4919433077 (already listed as an
impossible capture) and 4920414446 (hand 937, archived before the wrapper recorded post-ins). Two old test fixtures were under-specified by the new lost-fold rule (a
seat in the hand with no preflop action at all) and now carry that seat's own action; nothing else was loosened.

### Golden-range differences (37 hands, 10 identical today) and my judgement

- **Old solves wrong, since corrected (12):** 4919042871, 4919059283, 4919080497, 4919080309, 4919174586, 4919260843,
  4919310204, 4919310706, 4919479162, 4919480043, 4919481532, 4919482064 (Sep 18-20 live): same chart, today's input equals
  the hand's latest stored solve (Sep 23 replays) exactly; the first live solve differs (e.g. UTG K6s 0.90 then, 0 now).
  Corrected before Sep 23 (rotation / borrow / stacks-as-dealt fixes), not a regression.
- **Intended design change (5):** 4919211085, 4919245717, 4919482454, 4919670565, 4919957671: the limp chart is now the
  pool-locked one (olimp → olimp_pool/pool3, 2026-09-24 hand 729). 4919482454 also shows a 297bb flop stack today: the row
  predates startStacks and the CO's end stack is absent, so the dealt reconstruction has no opponent stack and the depth
  falls to hero's (see deferred 5).
- **The preflop pin's chart (7) — by Brady's pin design, two flagged:** the flop now reads the chart hero's preflop
  decision was read on, where the live solve re-picked on the full line. 4920395352, 4920397441, 4919311782: the chart
  that modelled a short stack behind the opener (who later folded) — arguably more faithful (the open was chosen facing
  him). 4919312009, 4919213506, 4919261748: hero opened 2x on the default 2.5x chart; live used the exact 2x chart, today
  the 2.5x chart with "BTN's 2bb read as 2.5bb" in the note. 4920395179: two shorts (BTN 78, BB 30); the pin's chart models
  the BTN (who folded), live modelled the 30bb BB (who called): BB AJs calls 0.96 then, 0.10 now. Deferred 1 and 2.
- **Now refused, named (3):** 4919197336 (hero opened 54s at 0%: OFF THE CHART → AI tree, Brady's rule),
  4919212912 (the SB's 3-bet to 4 is 0.63 log-distance from the chart's 7.5: past τ, fix 1 — the old solve was
  conditioned on a node that was not the table's: old solve wrong), 4919049350 (archived row without hero's cards).

### Live verification against GTO Wizard

Tool: `scripts/mutation/liveVerify.ts` (a harness case dealt as the sweep deals it; at its first postflop decision the
solver input is built as a dry run, then solved for real; the stored trace's spec — every seat's 1326 range, pot, stack,
street tokens — must equal the dry run, and hero's mix must not be all-zero). Every live run: `GTOW_SECONDARY=0
GTOW_RESERVE=450 GTOW_REQUEST_ORIGIN=harness`, 3 s pacing, primary (Ultra) only, stop on any 429.

- **Spent: 426 GTO Wizard requests, 68 solutions, all on the Ultra account, 0 on Elite**, logged in this worktree's
  `data/gtow_requests.jsonl` (origin `harness`). 17 of them (4 solutions) on 2026-09-24 22:16 UTC hit an immediate 429
  ("request_limit 1275 / 86400 s") and the run stopped, no retry; the rest after the UTC reset (2026-09-25 06:28-06:45),
  when the main ledger showed 0 Ultra requests since midnight. 7 polls returned 400 during the batches; every decision
  still answered.
- **Round-1 and round-2 fix classes, 20 cases, 18 solves:** seeds 2, 17 [late-fold], 3, 12, 27266 [missed-fold],
  111 [limps], 2775 / 5 [nl5], 1333, 21901 [jam], 44, 86 [baseline], 1669 [short-seat], 2807 [hero-deviates],
  8 [post-in], 412 [post-in + missed-fold], 22 [undealt-seat], 93 [hero-deviates, a 4-way collapse: first plan
  compared]: **every one answered (1.3-7.1 s), no all-zero mix, and what GTO Wizard was sent equals the dry run** (ranges,
  pot, stack, tokens). 589, 1231, 3992 had no postflop decision this time (hero's live preflop roll folded).
- **The cloud-gated paths:** hero deviation → AI tree (seeds 2, 3 [hero-deviates]: "OFF THE CHART (hero's own line)",
  answered, sent == dry run); an AI-pinned hand (144, 6, 50: "PREFLOP RANGES FROM THE PIN: the GTO Wizard AI preflop
  tree…", answered, sent == dry run); mis-mapped jams → exact tree (32, 51, 133 [jam]: the preflop decision answered by
  `gtow-ai-preflop`; 32's flop answered from the AI ranges); the pinned chart cannot hold the line → AI (18287:
  answered, the note says so). Kept callers → AI piece (2593, 3935) and chart-changed (14999): the AI preflop piece
  answered the preflop decision; hero then folded, so no flop to check. A first run showed seed 144 as a dry-vs-live
  mismatch: the dry run was blocked from reading the AI preflop tree, so its ranges fell to the charts — a harness
  artefact, fixed in liveVerify (6ad965d0), then matched.
- **chainReuseStress --twice** on 4920432199, 4920429872, 4920428867, 4920424636 (135 requests, 34 solves): 30
  decisions, 30 answered, every second ask all-cache (5-13 ms), node reads 42 with 0 read twice, earlier-street reuse
  29/30. The one miss is 4920429872's turn: hero check-RAISED the flop (4.8 over 1.8), and the flop tree had to be
  re-created with hero's own raise size pinned ("fixed sizes [31.6%]→[31.6%,32.3%]") — the size did not exist when hero
  was asked. Not touched by this round's commits (none change aiChain or tree sizing); a design limit, said here.

### Merge with zenbook-main and the new operators

Merged e5d4cdd8 / c44326c9 / bc74cfcf (+ the wrapper post-in commits) / 2fdcb0ba (wrapper only); conflicts only in fastSolve's imports and
foldPostIns' note (kept "left in the pot as dead money" with the dead post now in the pot, and "is yet to act").
`studyPoller.test`, `rollDecision.test`, `answerIntegrity.test` pass on the merged tree. New operators, modelled on the
wrapper's own export (test/unit/post-in.test.ts): `post-in` (a live post in WS order after the blinds, 1bb or 0.4bb at 5c,
hero the poster in ~35%, free option check-or-raise, call as the increment) and `undealt-seat` (a labelled non-blind seat
absent from liveSeats and startStacks, no action). Their first sweep found classes 7-12 and 15; after the fixes both are
clean (fresh 18301..21300: post-in 4,623 ok / 405 cloud-gated / 0 findings; undealt-seat 3,204 / 849 / 0).

### Numbers

| run (current code unless said) | cases | hero decisions | findings |
|---|---:|---:|---:|
| seeds 1..60, first run of the new oracle (before any round-2 fix) | 1,140 | 1,614 | 38 |
| seeds 301..3300, 4,000 pairs (after fixes 1-2) | 61,000 | 85,614 | 8 → fixes 3-5 |
| seeds 12301..15300, 6,000 pairs | 69,000 | 97,708 | 1 → fix 14 |
| seeds 15301..18300, 6,000 pairs | 69,000 | 98,347 | 11 → fixes 16, 17 |
| seeds 21301..24300, 6,000 pairs | 69,000 | 97,681 | 1 → fix 18 |
| seeds 24301..27300, 6,000 pairs + 6,000 triples | 75,000 | 108,076 | 4 → fix 19 |
| seeds 27301..30300, 6,000 pairs + 8,000 triples | 77,000 | 110,813 | 2 → fix 20 |
| seeds 40001..43000, 6,000 pairs + 10,000 triples | 79,000 | 113,110 | **0** |
| seeds 43001..46000, 6,000 pairs + 12,000 triples | 81,000 | 116,656 | 1 (deferred 8) |
| **final, seeds 1..300, 300 pairs, all 20 operators** | 6,600 | 9,252 | **0** |

Final single-operator matrix (ok / cloud-gated / expected-refusal / finding): baseline 413/4/0/0, post-in 450/39/0/0,
undealt-seat 328/53/0/0, missed-fold 390/0/0/0, jam 357/41/0/0, hero-deviates 385/76/0/0, dropped-call 239/5/215/0,
unlabelled-seat 56/0/417/0, dead-sb 0/493/0/0. Range oracle on the final run: 360 answers whose ranges differ from
the reference as a named, seat-specific approximation explains (audited: all "line fitted" / caller-cap cases), 219
the reference could not walk (caller caps, approximation named).

- Gate (`MUTATION_GATE=1`, `mutationHarness.test.ts` + `mutationHarness.fixtures.test.ts`, 53 replay seeds): **54 pass,
  0 fail**.
- `bun test`: **806 pass, 54 skip, 2 fail** (the known data-dependent pair: hrc3max NL25 `resolved-charts.json`,
  mesPostflop turn `mes_turn`).
- `tsc --noEmit`: only the two pre-existing `_replayFlopRoot729.ts` / `_replayStreets729.ts` errors.
- Golden ranges: 37 hands, 10 identical, every difference judged above.

### Deferred to Brady

1. **Two short stacks and the pin (hand 4920395179).** The uneven charts model one short seat; the pin keeps the one
   chosen at hero's decision (the first short behind him) even when he folds and the other short calls. Options: re-pick
   the short-stack chart for the flop's ranges when the modelled short folded and another short is in (breaks "no chart
   chosen again"), or accept.
2. **Hero's executed open size off the pinned chart (4919312009 et al.).** A 2x open read on the 2.5x chart (said in the
   note) where an exact 2x chart exists. Same trade-off as 1.
3. **GTO Wizard budget unit.** The ledger shows 5,497 Ultra requests (819 solutions) in the 24 h before the first 429, and
   no 429 before it, so neither unit matches the stated 1,275/86,400 s; by the ledger's own rule the Ultra headroom is 0,
   so `GTOW_RESERVE` cannot be used as specified against the shared ledger (liveVerify.ts budgets on the main ledger's
   solutions since 00:00 UTC instead, read-only). Worth settling before the next backtest.
4. **More cloud for three edge classes (fixes 14, 17, and 1's refusals):** they now go to the AI preflop tree instead of
   returning a zero-weight or off-node answer. Measured: 2 of 9,252 decisions in a 300x300 sweep moved from ok to
   cloud-gated with fix 17.
5. **No readable opponent stack → depth = hero's stack** (golden 4919482454, an archive artefact: 297bb). chartFor6max
   assumes 100bb for an unreadable opponent; dealtEffective does not. Live exports carry every stack, so not fixed.
6. **reconstructFlopRanges cannot snap onto a label-less "All-in"** (the token carries the size; walk3max can), so jam
   lines the per-seat fits could read fall through (to the pinned walk, or the AI tree). No wrong input, only more cloud.
7. **The pot ledger's 0.6bb slack (round 1, item 5).** A lost SB complete (0.5bb, 0.6 at 5c) is arithmetically the same
   as an uncaptured dead small blind, so a lost complete by an SB who then folds with no other action stays invisible.
   Fix 20 closes the case where he plays a later street. Now that the wrapper records posts (766de6d4), if it also
   exports DEAD posts as actions the slack can drop to rounding — worth confirming with the wrapper session.
8. **A flop with <= 0.5bb behind is refused "(near) all-in"** (fresh sweep 43001..46000, seed 44131 [short-seat]: the
   23bb BTN 4-bets to 22.5 and is called; 0.5bb behind). A real table state, so by the rules it wants a solver input, but
   no bet below the minimum exists and I could not check what GTO Wizard does with a 0.5bb tree (no budget); the
   choice (answer it locally as all-in-or-check, or build the tree) is yours. The only unfixed finding class in the
   final sweeps.
9. Round 1's deferred items stand; item 4 there (posted blind refused) is superseded by zenbook-main's post-in work and
   fixes 7, 8, 11, 12 here; item 6 is closed by fix 20.

## Round 2.1 (2026-09-25): the villains' ranges re-picked (Brady's decision on deferred items 1 and 2)

Branch `worktree-agent-a1de9613a21d99521`, based on zenbook-main e789427c. The pin stays the rule. There is one
exception, and it covers the villains' ranges only (`services/preflopPin.repickVillainRanges`, called after a
successful chart-pin resume in fastSolve). It applies when what happened after hero's decision contradicts the pinned
chart's own assumption and the set holds an exact chart for what did happen. That exact chart is the one
`chartFor6max` picks for the full line with the pinned dealt stacks, and it counts only when it resolves with no
fallback. The villains are then read on it. Hero's range stays on the pinned chart. There are two triggers:
(a) the pinned uneven chart's short seat folded before the flop;
(b) the open played (snapped onto the set's sizes) differs from the pinned chart's open, and the full-line chart has
exactly that open.
The re-pick never fires for an AI-tree pin, when the exact chart is the pinned one, or when the resolver falls back.
A villain the exact chart cannot read (a missing node, a pruned branch, a size past τ, or no weight) keeps the pinned
read, and the note says so. The re-pick never causes a refusal. The trace mark is "preflop ranges re-picked". The
note reads "RANGES RE-PICKED FOR <seats>: <why>, so read on <exact>, the chart for the line as played — hero's range
stays on <pinned>".

Oracle: a villain range read on the re-picked chart counts as explained only when the note names the re-pick for that
seat. It must then equal the reference walk of the dealt line on that chart (layer 2), and its walk replays on that
chart (layer 1). The re-pick's own "BB: …" segment no longer counts as a borrow in `explainsSeat`.

**Golden ranges (41 hands in solves.sqlite today; round 2 counted 37).** Before: 14 identical. After: 13 identical.
In every re-picked hand below, hero's range is unchanged.

| hand | trigger | villain max diff vs the first stored solve, before → after |
|---|---|---|
| 4920395179 | (a) BTN modelled, folded → s30_BB | BB 0.864 (AJs 0.96 vs 0.10) → **0**; CO 0.297 → **0** |
| 4919312009 | (b) 2x played → D100_o2 | BB 1.000 (65o) → **0** |
| 4919213506 | (b) 2x played → D100_o2 (full-line rung 100; the pin was D125) | BB 1.000 (63s) → **0** |
| 4919261748 | **(a), not "unchanged"**: the modelled 70bb BB folded (his fold was captured late, on the flop), so the full line has no short and the even D100_o2 exists | BTN 0.988 (A3o) → **0** |
| 4920397441 | (a) BTN 30 folded → D100_o2_5 | BB 0.678 → **0** |
| 4920395352 | (a) CO 70 folded → D100_o2_5 | HJ 0.307 → **0** |
| 4919311782 | (a) BTN 70 folded → D100_o2_5 | SB 0.220 → 0.232 (AJs 0.925 then, 0.693 now). Now equal to the reference walk on D100_o2_5; the Sep-19 solve belongs to the "old solves wrong" class (hero's UTG differs from it as much) |
| 4920544213 | (a) SB 30 modelled, folded; BB 49 called → s50_BB | BB 0 → 0.982 (JTs: 0.018 on s30_SB, 1.0 on s50_BB). This is the one classification that moved (identical → differs), because its stored solve was a live one made with the pin (2026-09-25 07:04). It is the same two-shorts case as 4920395179 |

No other hand moved.

**Tests and runs.**
- Unit tests: `services/preflopPin.repick.test.ts` (11) and `rangeOracle.test.ts` "the ranges re-pick" (4). The
  switch tests fail with a stubbed re-pick.
- Gate fixtures: 51048 [jam] (a) and 51047 [short-seat] (a)+(b) assert the note and a clean oracle.
- `tsc`: only the two `_replay…729` errors.
- `bun test`: 821 pass / 56 skip / 2 fail (the known hrc3max NL25 and mesPostflop turn failures).
- Gate: 87 / 87.
- Sweep, seeds 51001..51300 with 300 pairs: 6,600 cases, 9,179 decisions, **0 findings**. 38 re-picked answers were
  verified on the re-picked chart.
- Sweep, seeds 52001..53500 with 3,000 pairs and 3,000 triples: 37,500 cases, 53,354 decisions, **0 findings**. 195
  re-picked answers were verified.
