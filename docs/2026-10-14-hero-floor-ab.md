# Hero's class floor — A/B (2026-10-14)

Brady: "do some strong A/B testing first to figure out the best approach and whether or not this floor is a good move or
not." Branch `claude/hero-floor` (from main aa40346). Nothing merged; the default stays `abs`.

## The question

`services/aiChain.ts` lifts every unblocked combo of hero's hand class to weight ≥ 0.05 (absolute) in his own entering
range at every street, so a strategy can be read at his node and suit isomorphism holds. On a thin hero range (a rare
line, or his own earlier actions narrowing him under ~20 combos) 0.05 is the heaviest weight he holds: his class becomes
15-100 % of what villain believes he has, and villain is solved against a hero who all but shows his hand (answer-path
audit 2026-10-14, finding 2). Two regimes: (a) a rare line hero's class takes at a real frequency — the shape is right,
the floor overstates the class 5-40×; (b) hero deviated (natural weight ≈ 0) — no belief is "right", but "hero always has
exactly this" is the worst one for him.

## The switch — `HERO_CLASS_FLOOR` (aiChain.applyHeroClassFloor, default `abs`, behaviour unchanged)

| mode | the lift | note |
|---|---|---|
| `abs` | class ≥ 0.05 | today (since 2026-09-17), the control |
| `rel5` | class ≥ 0.05 × heaviest live combo weight in hero's range (board removed) | = abs on a full-weight range |
| `rel1` | class ≥ 0.01 × that | |
| `none` | class ≥ max(1e-6 × max, 1e-6) | the natural reference: his combo exists, a strategy can be read |

Every mode lifts the whole class (suit isomorphism), card removal stays absolute, a weight already above the floor is
kept, and the lift is idempotent (a resumed street re-applies it). Each street's trace record now carries `heroFloor`
(mode, lift, hero's live mass / class mass / own combo before and after). Unit test: `aiChain.heroFloor.test.ts`.

## Method — `src/scripts/heroFloorAb.ts`

Real decisions, re-walked OFFLINE with the live walker (`solveAiChain` on each decision's stored spec from the solves
table's trace) under each mode, GTO Wizard asked through the account pool (every request in the live ledger under origin
`heroFloorAb`; the solve cache a COPY, `GTOW_CACHE_DB_PATH`; `GTOW_PREFETCH=0`). A tree whose ranges a mode does not
change is a cache hit (free); only ranges the floor changes are solved again.

- A hand is walked **decision by decision, in order, under one hand key per (mode, hand)**: the turn and river resume
  from the mode's own earlier streets (the floor compounds per street — part of what is measured), and hero's own
  earlier actions are narrowed by the node the MODE answered them on (`recordAnsweredHeroNode`, as live).
- **The blind spot** (a replay runs under a fresh hand key, so `aiChain.ts`'s answered/served narrowing never finds the
  live hand's records): every trace node carrying `heroAnswered.strategy` (4 dp) is seeded under the walk's key before
  the decision is walked, unless the mode's own earlier walk already answered that point. The seed is 4 dp where live
  was full precision, so the next street's tree is re-keyed and re-solved (a fresh QRE solve on near-identical ranges).
- Recorded per decision and mode: hero's node (his combo's mix and per-action EV, bb), his live mass and class share
  entering every street (`heroFloor`), whether each street's tree request was the live one (`sentSame`: menus, pot,
  stacks, rake, range weights within 1 %), trees created, requests (tree / solution / poll).
- Metrics: pick per mode and whether it changed vs abs; class share; **loss(v | ref) = max_a EV_ref(a) − Σ_a mix_v(a)·EV_ref(a)**
  — the best-response loss of v's mix evaluated with the reference mode's EVs (the reference's villain). Primary
  reference `none` (regime a only — hero's natural weight on the decision street > 1e-4 × his heaviest combo); secondary
  `rel5` (covers regime b); and the reverse (none's mix under abs's EVs) so the asymmetry shows.
- Guards: a live session stops it; a 429 stops it; an account past 1,000 requests in its last hour makes it wait.

### Sample (`src/scripts/heroFloorAbSample.py`, from the stored traces, read-only)

- tier 1: every ai-chain answer since 2026-10-01 whose hero live mass on the decision street is < 5 combos — 46
  decisions in 27 hands (every decision of those hands walked, 86 decisions).
- tier 2: 20 random decisions with 5-20 combos (20 hands); tier 3: 10 controls with > 100 combos and no floor lift on
  any street, from hands since 10-09 (their trees are in the cache: free in every mode).
- Modes abs, none, rel5 on all tiers; rel1 on tier 1 only if the budget allowed (see Requests).

### What the reproduction check can and cannot claim

The solve cache keeps 14 days / 500 MB; on 2026-10-14 it held trees from 10-09 on. The menus changed on 10-08 evening
(heads-up menu F, three-way menu C, sizes on the net pot), so a decision before 10-09 cannot be replayed on its live
tree whatever the mode: its trees are re-solved under today's menus (the same for every mode — apples to apples, and
what the product uses now), and its "repro" column is marked re-solved. The reproduction claim below is made on the
decisions from 10-09 on, where `abs` walked the live tree (`sentSame` on every street).

## Results

Runs 2026-10-14 (scratchpad `herofloor/run1`, 647 decision-walks in all): abs + none + rel5 on every tier, rel1 on
tier 1. One walk failed on a transient (13827 abs: a solve timed out on ultra-2); the hand's later decisions walked.

### Reproduction (the `abs` walk against what answered live)

- 107 decisions had their live tree on every street (`sentSame`): **105 reproduced** — hero's decision-street mass and
  class mass within rounding, the same pick, the mix within 0.09 (63 decisions whose every node came from the cache:
  63/63 same pick, max mix Δ 0.09). The 2 that differ (13567, 14991) are decisions whose chain needed a FRESH cloud
  solve of a byte-identical request (the live tree had left the cache; a debug walk confirms the request and all three
  ranges identical, max weight difference 0): GTO Wizard's second solve disagrees with its first — 13567 TT facing a
  4.6 raise: live CALL 94.5 % (EV 5.89) / now RAISE 97.4 % (EV 10.80); 14991 live FOLD 93.8 % / now CALL 100 %.
  Of 44 decisions whose chain held such a fresh identical solve, 42 kept the pick. **That 2/44 is the solver's own
  re-solve variance and the noise floor for every "pick changed" below.**
- 75 decisions (every hand before 10-09, and the streets after a 4-dp seed) were re-solved under today's menus / a
  re-keyed range — not comparable to the live node, comparable across modes.
- The seeded narrowing worked as intended: 16240 (live narrowed by a served mix from another plan) reproduced to
  mass Δ 0.001 / mix Δ 0.002 after the seed; 16237's served pick (CHECK 83 %) was a BLEND over three plans while the
  trace's own node is BET 67.9 % — the check compares with the trace node, and it matched exactly.

### Readability of a near-zero-weight hero combo

Under `none` hero's weight at his node was as low as 2e-5 (median of the lifted cases ~4e-4) and GTO Wizard still
returned a proper node every time: 183 nodes, 0 with a mix outside [0.99, 1.01], 0 without finite non-zero EVs. So
`none` and `rel` ARE readable. But check #17 (`HERO_ABSENT_WEIGHT` = 1e-3 absolute) would FAIL them as "hero absent":
among the tier-1 answers abs trips it 4 times, rel5 / rel1 12, none 16. **Any switch needs #17's bound made relative**
(e.g. 1e-3 × hero's heaviest live combo) in the same change.

### Aggregates (tagged decisions; excess = loss under the reference's EVs minus the reference's own QRE regret)

Tier 1 — hero < 5 combos on the decision street (47 decisions, 27 hands):

| mode | excess loss vs none: mean / median / p95 / max (bb) | excess vs rel5: mean | mix played under abs's villain: loss mean | pick ≠ abs | class share median | mass median |
|---|---|---|---|---|---|---|
| abs (today) | **0.134** / 0.000 / 0.664 / 2.677 | 0.108 | 0.014 (its own regret) | — | 18 % | 1.44 |
| rel5 | 0.000 / 0.000 / 0.002 / 0.022 | 0.000 | 0.043 | 8 / 47 | 7 % | 1.25 |
| rel1 | 0.000 / 0.000 / 0.001 / 0.005 | 0.001 | 0.044 | 8 / 47 | 7 % | 1.25 |
| none | 0 (reference) | 0.001 | 0.045 | 8 / 47 | 7 % | 1.25 |

- By street (abs's excess vs none, mean / max): flop 0.342 / 2.677 (8), turn 0.050 / 0.664 (16), river 0.121 / 2.619 (23).
- By how far hero's natural weight sits under his heaviest live combo: < 1 %: 2.677 (1 decision, 10843); 1-10 %: 0.050
  (4); 10-50 %: 0.010 (24); ≥ 50 % — hero's whole range thin, not only his class: 0.178 mean / 2.619 max (18). The floor
  hurts most where the whole range is under 0.1 combos per hand and 0.05 makes his class a quarter of it.
- The asymmetry: if abs's belief were the right one, playing none's mix costs 0.045 − 0.014 = **0.031 bb**; if the
  natural belief is right, playing abs's mix costs **0.134 bb**. Four to one against the floor.
- Picks: rel5, rel1 and none change the SAME 8 of 47 picks vs abs (17 %, against the 4.5 % re-solve noise floor), and
  **rel5 vs none and rel1 vs none differ on 0 of 47**. rel5's trees differed from none's on 30 of the 72 streets none
  re-solved; it never changed a decision.
- Regime b (hero's natural weight under 1e-4 × his heaviest combo — "hero deviated") did NOT occur in the sample: all
  47 are regime a (the smallest ratio 0.01 %, answer 10843). The floor's "no belief is right" case is unmeasured.

Tier 2 — 5-20 combos (19 decisions): abs's excess 0.001 mean / 0.022 max, 0 of 19 picks change under any mode.
Tier 3 — > 100 combos, no lift (10 decisions): every mode identical (0.000, 0 picks), at no request. **The floor is a
sub-5-combo question**: 46 of the 2,482 ai-chain decisions since 10-01 (1.9 %).

### Where the choice matters most

1. **10843** — 4922269408, flop, UTG A♦Q♣ facing a raise, 3.16 live combos, hero's natural weight 0.0001 (0.01 % of his
   heaviest combo). abs: hero's class is 19 % of his range; the tree answers **FOLD 66.9 / CALL 33.1** (CALL EV +0.01).
   none: class share 0 %, **CALL 100 %** at EV **+4.00**; rel5 CALL 99.9 % at +2.11, rel1 CALL 100 % at +3.51. Excess
   loss of abs's mix under the natural villain: **2.68 bb**. Served live: FOLD 70.5 %.
2. **9654** — 4921735323, river, CO K♥K♠ facing a bet, 1.05 combos, natural weight 0.0135 (61 % of his heaviest — the
   whole range is residue). abs: class 29 % of his range, **FOLD 71 / CALL 29** (CALL EV −0.06). none / rel5 / rel1:
   class 9 %, **CALL 100 %** at EV **+3.69**. Excess 2.62 bb. Served live: FOLD 75 %.
3. **16646** — 4924401843, turn, BB T♣A♠ after a limp-pool line, 0.64 combos, class share **70 %** under abs: **ALLIN
   83.5 %** (EV 15.71). none / rel5: class 20 %, BET 6.4 45.8 % / BET 9.7 41 % (EV 17.22-17.24), all-in 0 %. Excess
   0.66 bb. Served live: ALLIN 83.5 %, executed.

The 8 pick changes are listed in the table (answers 9654, 10273, 10843, 12802, 12803, 15384, 16241, 16646); all are
abs's hero playing against a villain who was solved knowing his class — folding made hands (KK, AQ), checking the river
with the class share at 43 %, jamming a turn at 70 %.

### Requests

**1,218 GTO Wizard requests in all** (pilot 40 + run 1,063 + rel1 115; origin `heroFloorAb` in the live ledger), on
the two Ultra accounts (ultra-2 ~880, primary ~220, least-loaded routing), no 429, no wall; at the end ultra-2 stood at
889 in its last hour (cap 2,250), primary 245. Trees created: abs 119 (the pre-10-09 hands and the re-keyed streets
after a seed), none 72, rel5 30, rel1 9; 581 of the requests were abs's — the price of re-solving old hands under
today's menus. Cache copy: `GTOW_CACHE_DB_PATH` on a VACUUM INTO copy; the live cache untouched.

## Recommendation

**Change the floor to `rel5`** (hero's class ≥ 0.05 × his heaviest live combo), with check #17's absent bound made
relative in the same change and the departure registered (`services/approximations.ts`). Numbers: on the 47 decisions
where the floor bites (hero under 5 combos, 1.9 % of postflop decisions) today's `abs` mix loses 0.134 bb per decision
against the natural villain (max 2.68 — a folded A♦Q♣ and K♥K♠ at +4.0 / +3.7 bb), while `rel5` loses 0.000 (max
0.022) and differs from the natural reference on 0 of 47 picks; the reverse bet (abs's belief right, rel5's mix
played) costs 0.031. Above 5 combos the modes are identical (tier 2: 0.001 bb, 0 pick changes; tier 3: 0). rel5 over
`none`: the same picks and losses, but a floor that keeps hero's class readable at 5 % of his heaviest combo (12 of 47
nodes under 1e-3 vs 16) and is identical to today's behaviour on every full-weight range by construction. rel1 adds
nothing measurable over rel5 (0 pick differences, excess ≤ 0.005). Caveats to weigh: the solver's own re-solve
variance flips 2 of 44 identical requests (EV moving 2-5 bb), larger per decision than the floor's typical effect, so
the case rests on the mean and the tail, not on any one hand; regime b (hero deviated to weight ≈ 0) never occurred in
14 days and is unmeasured — there rel5 still lifts him to 5 % of his heaviest combo, a belief, not the truth. The
default is NOT flipped here: `HERO_CLASS_FLOOR=rel5` in `config/local.env` is Brady's call.

## Appendix — the generated report (`bun src/scripts/heroFloorAb.ts --report <dir>`)


## Aggregates (tagged decisions = the sampled ones; a hand's other decisions were walked for the chain and are in the table)

#### tier t1, all (47 decisions)
| mode | n | EXCESS loss vs none: mean / median / p95 / max (bb) | loss vs none: mean / median | excess vs rel5: mean / median | loss under abs's EVs: mean | pick ≠ abs | class share: median | mass: median |
|---|---|---|---|---|---|---|---|---|
| abs | 47 | 0.134 / 0.000 / 0.664 / 2.677 (n=47) | 0.149 / 0.006 | 0.108 / 0.000 (n=47) | 0.014 (n=47) | 0 / 47 | 18% | 1.44 |
| rel5 | 47 | -0.000 / 0.000 / 0.002 / 0.022 (n=47) | 0.015 / 0.005 | 0.000 / 0.000 (n=47) | 0.043 (n=47) | 8 / 47 | 7% | 1.25 |
| rel1 | 47 | -0.000 / 0.000 / 0.001 / 0.005 (n=47) | 0.015 / 0.005 | 0.001 / 0.000 (n=47) | 0.044 (n=47) | 8 / 47 | 7% | 1.25 |
| none | 47 | 0.000 / 0.000 / 0.000 / 0.000 (n=47) | 0.015 / 0.005 | 0.001 / 0.000 (n=47) | 0.045 (n=47) | 8 / 47 | 7% | 1.25 |

#### tier t1, regime a (hero's natural weight > 1e-4 × max) (47 decisions)
| mode | n | EXCESS loss vs none: mean / median / p95 / max (bb) | loss vs none: mean / median | excess vs rel5: mean / median | loss under abs's EVs: mean | pick ≠ abs | class share: median | mass: median |
|---|---|---|---|---|---|---|---|---|
| abs | 47 | 0.134 / 0.000 / 0.664 / 2.677 (n=47) | 0.149 / 0.006 | 0.108 / 0.000 (n=47) | 0.014 (n=47) | 0 / 47 | 18% | 1.44 |
| rel5 | 47 | -0.000 / 0.000 / 0.002 / 0.022 (n=47) | 0.015 / 0.005 | 0.000 / 0.000 (n=47) | 0.043 (n=47) | 8 / 47 | 7% | 1.25 |
| rel1 | 47 | -0.000 / 0.000 / 0.001 / 0.005 (n=47) | 0.015 / 0.005 | 0.001 / 0.000 (n=47) | 0.044 (n=47) | 8 / 47 | 7% | 1.25 |
| none | 47 | 0.000 / 0.000 / 0.000 / 0.000 (n=47) | 0.015 / 0.005 | 0.001 / 0.000 (n=47) | 0.045 (n=47) | 8 / 47 | 7% | 1.25 |

#### tier t1, regime b (hero deviated: natural weight ≈ 0) (0 decisions)
| mode | n | EXCESS loss vs none: mean / median / p95 / max (bb) | loss vs none: mean / median | excess vs rel5: mean / median | loss under abs's EVs: mean | pick ≠ abs | class share: median | mass: median |
|---|---|---|---|---|---|---|---|---|
| abs | 0 | — / — / — / — (n=0) | — / — | — / — (n=0) | — (n=0) | 0 / 0 | — | — |
| rel5 | 0 | — / — / — / — (n=0) | — / — | — / — (n=0) | — (n=0) | 0 / 0 | — | — |
| rel1 | 0 | — / — / — / — (n=0) | — / — | — / — (n=0) | — (n=0) | 0 / 0 | — | — |
| none | 0 | — / — / — / — (n=0) | — / — | — / — (n=0) | — (n=0) | 0 / 0 | — | — |

#### tier t1, flop (8 decisions)
| mode | n | EXCESS loss vs none: mean / median / p95 / max (bb) | loss vs none: mean / median | excess vs rel5: mean / median | loss under abs's EVs: mean | pick ≠ abs | class share: median | mass: median |
|---|---|---|---|---|---|---|---|---|
| abs | 8 | 0.342 / 0.007 / 2.677 / 2.677 (n=8) | 0.358 / 0.022 | 0.184 / 0.007 (n=8) | 0.011 (n=8) | 0 / 8 | 14% | 3.16 |
| rel5 | 8 | 0.000 / 0.000 / 0.002 / 0.002 (n=8) | 0.017 / 0.013 | 0.000 / 0.000 (n=8) | 0.013 (n=8) | 3 / 8 | 4% | 2.67 |
| rel1 | 8 | 0.000 / 0.000 / 0.000 / 0.000 (n=8) | 0.016 / 0.013 | -0.000 / 0.000 (n=8) | 0.013 (n=8) | 3 / 8 | 2% | 2.58 |
| none | 8 | 0.000 / 0.000 / 0.000 / 0.000 (n=8) | 0.016 / 0.013 | -0.000 / 0.000 (n=8) | 0.013 (n=8) | 3 / 8 | 2% | 2.56 |

#### tier t1, turn (16 decisions)
| mode | n | EXCESS loss vs none: mean / median / p95 / max (bb) | loss vs none: mean / median | excess vs rel5: mean / median | loss under abs's EVs: mean | pick ≠ abs | class share: median | mass: median |
|---|---|---|---|---|---|---|---|---|
| abs | 16 | 0.050 / 0.000 / 0.125 / 0.664 (n=16) | 0.067 / 0.006 | 0.051 / 0.000 (n=16) | 0.021 (n=16) | 0 / 16 | 18% | 1.08 |
| rel5 | 16 | -0.002 / 0.000 / 0.001 / 0.001 (n=16) | 0.016 / 0.008 | 0.000 / 0.000 (n=16) | 0.097 (n=16) | 2 / 16 | 10% | 0.74 |
| rel1 | 16 | -0.001 / 0.000 / 0.000 / 0.001 (n=16) | 0.017 / 0.008 | 0.002 / 0.000 (n=16) | 0.100 (n=16) | 2 / 16 | 10% | 0.74 |
| none | 16 | 0.000 / 0.000 / 0.000 / 0.000 (n=16) | 0.018 / 0.008 | 0.003 / 0.000 (n=16) | 0.101 (n=16) | 2 / 16 | 10% | 0.74 |

#### tier t1, river (23 decisions)
| mode | n | EXCESS loss vs none: mean / median / p95 / max (bb) | loss vs none: mean / median | excess vs rel5: mean / median | loss under abs's EVs: mean | pick ≠ abs | class share: median | mass: median |
|---|---|---|---|---|---|---|---|---|
| abs | 23 | 0.121 / 0.000 / 0.096 / 2.619 (n=23) | 0.133 / 0.003 | 0.121 / 0.000 (n=23) | 0.009 (n=23) | 0 / 23 | 18% | 2.78 |
| rel5 | 23 | 0.001 / 0.000 / 0.002 / 0.022 (n=23) | 0.013 / 0.003 | 0.000 / 0.000 (n=23) | 0.016 (n=23) | 3 / 23 | 9% | 2.34 |
| rel1 | 23 | 0.000 / 0.000 / 0.001 / 0.005 (n=23) | 0.012 / 0.003 | -0.000 / 0.000 (n=23) | 0.016 (n=23) | 3 / 23 | 9% | 2.67 |
| none | 23 | 0.000 / 0.000 / 0.000 / 0.000 (n=23) | 0.012 / 0.003 | -0.000 / 0.000 (n=23) | 0.016 (n=23) | 3 / 23 | 9% | 2.19 |

#### tier t1, hero's natural weight natural / max < 1 % of his heaviest combo (1 decisions)
| mode | n | EXCESS loss vs none: mean / median / p95 / max (bb) | loss vs none: mean / median | excess vs rel5: mean / median | loss under abs's EVs: mean | pick ≠ abs | class share: median | mass: median |
|---|---|---|---|---|---|---|---|---|
| abs | 1 | 2.677 / 2.677 / 2.677 / 2.677 (n=1) | 2.678 / 2.678 | 1.413 / 1.413 (n=1) | 0.009 (n=1) | 0 / 1 | 19% | 3.16 |
| rel5 | 1 | 0.002 / 0.002 / 0.002 / 0.002 (n=1) | 0.003 / 0.003 | 0.000 / 0.000 (n=1) | 0.000 (n=1) | 1 / 1 | 4% | 2.67 |
| rel1 | 1 | 0.000 / 0.000 / 0.000 / 0.000 (n=1) | 0.001 / 0.001 | -0.001 / -0.001 (n=1) | 0.000 (n=1) | 1 / 1 | 1% | 2.58 |
| none | 1 | 0.000 / 0.000 / 0.000 / 0.000 (n=1) | 0.001 / 0.001 | -0.001 / -0.001 (n=1) | 0.000 (n=1) | 1 / 1 | 0% | 2.56 |

#### tier t1, hero's natural weight 1-10 % of his heaviest combo (4 decisions)
| mode | n | EXCESS loss vs none: mean / median / p95 / max (bb) | loss vs none: mean / median | excess vs rel5: mean / median | loss under abs's EVs: mean | pick ≠ abs | class share: median | mass: median |
|---|---|---|---|---|---|---|---|---|
| abs | 4 | 0.050 / 0.093 / 0.096 / 0.096 (n=4) | 0.058 / 0.093 | 0.056 / 0.097 (n=4) | 0.018 (n=4) | 0 / 4 | 43% | 0.99 |
| rel5 | 4 | -0.001 / 0.000 / 0.000 / 0.000 (n=4) | 0.008 / 0.013 | 0.000 / 0.000 (n=4) | 0.028 (n=4) | 1 / 4 | 1% | 0.67 |
| rel1 | 4 | 0.000 / 0.000 / 0.000 / 0.000 (n=4) | 0.009 / 0.013 | 0.000 / 0.000 (n=4) | 0.029 (n=4) | 1 / 4 | 1% | 0.67 |
| none | 4 | 0.000 / 0.000 / 0.000 / 0.000 (n=4) | 0.009 / 0.013 | 0.000 / 0.000 (n=4) | 0.029 (n=4) | 1 / 4 | 0% | 0.67 |

#### tier t1, hero's natural weight 10-50 % of his heaviest combo (24 decisions)
| mode | n | EXCESS loss vs none: mean / median / p95 / max (bb) | loss vs none: mean / median | excess vs rel5: mean / median | loss under abs's EVs: mean | pick ≠ abs | class share: median | mass: median |
|---|---|---|---|---|---|---|---|---|
| abs | 24 | 0.010 / 0.002 / 0.036 / 0.125 (n=24) | 0.029 / 0.012 | 0.009 / 0.001 (n=24) | 0.016 (n=24) | 0 / 24 | 16% | 1.44 |
| rel5 | 24 | 0.001 / 0.000 / 0.002 / 0.022 (n=24) | 0.020 / 0.010 | 0.000 / 0.000 (n=24) | 0.062 (n=24) | 4 / 24 | 6% | 1.25 |
| rel1 | 24 | 0.000 / 0.000 / 0.001 / 0.005 (n=24) | 0.019 / 0.008 | -0.000 / 0.000 (n=24) | 0.062 (n=24) | 4 / 24 | 6% | 1.25 |
| none | 24 | 0.000 / 0.000 / 0.000 / 0.000 (n=24) | 0.019 / 0.008 | -0.000 / 0.000 (n=24) | 0.062 (n=24) | 4 / 24 | 6% | 1.25 |

#### tier t1, hero's natural weight ≥ 50 % of his heaviest combo (18 decisions)
| mode | n | EXCESS loss vs none: mean / median / p95 / max (bb) | loss vs none: mean / median | excess vs rel5: mean / median | loss under abs's EVs: mean | pick ≠ abs | class share: median | mass: median |
|---|---|---|---|---|---|---|---|---|
| abs | 18 | 0.178 / 0.000 / 0.664 / 2.619 (n=18) | 0.189 / 0.003 | 0.178 / 0.000 (n=18) | 0.009 (n=18) | 0 / 18 | 25% | 3.37 |
| rel5 | 18 | -0.002 / 0.000 / 0.000 / 0.001 (n=18) | 0.009 / 0.003 | 0.000 / 0.000 (n=18) | 0.023 (n=18) | 2 / 18 | 16% | 3.37 |
| rel1 | 18 | -0.001 / 0.000 / 0.000 / 0.001 (n=18) | 0.010 / 0.003 | 0.002 / 0.000 (n=18) | 0.026 (n=18) | 2 / 18 | 16% | 3.37 |
| none | 18 | 0.000 / 0.000 / 0.000 / 0.000 (n=18) | 0.011 / 0.003 | 0.003 / 0.000 (n=18) | 0.027 (n=18) | 2 / 18 | 16% | 3.37 |

#### tier t2, all (19 decisions)
| mode | n | EXCESS loss vs none: mean / median / p95 / max (bb) | loss vs none: mean / median | excess vs rel5: mean / median | loss under abs's EVs: mean | pick ≠ abs | class share: median | mass: median |
|---|---|---|---|---|---|---|---|---|
| abs | 19 | 0.001 / 0.000 / 0.001 / 0.022 (n=19) | 0.012 / 0.002 | -0.000 / 0.000 (n=19) | 0.013 (n=19) | 0 / 19 | 6% | 12.64 |
| rel5 | 19 | 0.001 / 0.000 / 0.003 / 0.019 (n=19) | 0.012 / 0.003 | 0.000 / 0.000 (n=19) | 0.013 (n=19) | 0 / 19 | 6% | 12.62 |
| rel1 | 0 | — / — / — / — (n=0) | — / — | — / — (n=0) | — (n=0) | 0 / 0 | — | — |
| none | 19 | 0.000 / 0.000 / 0.000 / 0.000 (n=19) | 0.011 / 0.003 | -0.001 / 0.000 (n=19) | 0.012 (n=19) | 0 / 19 | 5% | 12.64 |

#### tier t2, regime a (hero's natural weight > 1e-4 × max) (19 decisions)
| mode | n | EXCESS loss vs none: mean / median / p95 / max (bb) | loss vs none: mean / median | excess vs rel5: mean / median | loss under abs's EVs: mean | pick ≠ abs | class share: median | mass: median |
|---|---|---|---|---|---|---|---|---|
| abs | 19 | 0.001 / 0.000 / 0.001 / 0.022 (n=19) | 0.012 / 0.002 | -0.000 / 0.000 (n=19) | 0.013 (n=19) | 0 / 19 | 6% | 12.64 |
| rel5 | 19 | 0.001 / 0.000 / 0.003 / 0.019 (n=19) | 0.012 / 0.003 | 0.000 / 0.000 (n=19) | 0.013 (n=19) | 0 / 19 | 6% | 12.62 |
| rel1 | 0 | — / — / — / — (n=0) | — / — | — / — (n=0) | — (n=0) | 0 / 0 | — | — |
| none | 19 | 0.000 / 0.000 / 0.000 / 0.000 (n=19) | 0.011 / 0.003 | -0.001 / 0.000 (n=19) | 0.012 (n=19) | 0 / 19 | 5% | 12.64 |

#### tier t2, regime b (hero deviated: natural weight ≈ 0) (0 decisions)
| mode | n | EXCESS loss vs none: mean / median / p95 / max (bb) | loss vs none: mean / median | excess vs rel5: mean / median | loss under abs's EVs: mean | pick ≠ abs | class share: median | mass: median |
|---|---|---|---|---|---|---|---|---|
| abs | 0 | — / — / — / — (n=0) | — / — | — / — (n=0) | — (n=0) | 0 / 0 | — | — |
| rel5 | 0 | — / — / — / — (n=0) | — / — | — / — (n=0) | — (n=0) | 0 / 0 | — | — |
| rel1 | 0 | — / — / — / — (n=0) | — / — | — / — (n=0) | — (n=0) | 0 / 0 | — | — |
| none | 0 | — / — / — / — (n=0) | — / — | — / — (n=0) | — (n=0) | 0 / 0 | — | — |

#### tier t2, flop (2 decisions)
| mode | n | EXCESS loss vs none: mean / median / p95 / max (bb) | loss vs none: mean / median | excess vs rel5: mean / median | loss under abs's EVs: mean | pick ≠ abs | class share: median | mass: median |
|---|---|---|---|---|---|---|---|---|
| abs | 2 | 0.000 / 0.001 / 0.001 / 0.001 (n=2) | 0.011 / 0.018 | 0.000 / 0.001 (n=2) | 0.011 (n=2) | 0 / 2 | 6% | 16.62 |
| rel5 | 2 | 0.000 / 0.000 / 0.000 / 0.000 (n=2) | 0.011 / 0.018 | 0.000 / 0.000 (n=2) | 0.010 (n=2) | 0 / 2 | 6% | 16.62 |
| rel1 | 0 | — / — / — / — (n=0) | — / — | — / — (n=0) | — (n=0) | 0 / 0 | — | — |
| none | 2 | 0.000 / 0.000 / 0.000 / 0.000 (n=2) | 0.011 / 0.018 | 0.000 / 0.000 (n=2) | 0.010 (n=2) | 0 / 2 | 6% | 16.62 |

#### tier t2, turn (5 decisions)
| mode | n | EXCESS loss vs none: mean / median / p95 / max (bb) | loss vs none: mean / median | excess vs rel5: mean / median | loss under abs's EVs: mean | pick ≠ abs | class share: median | mass: median |
|---|---|---|---|---|---|---|---|---|
| abs | 5 | -0.000 / 0.000 / 0.000 / 0.000 (n=5) | 0.004 / 0.001 | -0.000 / 0.000 (n=5) | 0.004 (n=5) | 0 / 5 | 13% | 12.64 |
| rel5 | 5 | -0.000 / 0.000 / 0.000 / 0.000 (n=5) | 0.004 / 0.002 | 0.000 / 0.000 (n=5) | 0.004 (n=5) | 0 / 5 | 11% | 12.62 |
| rel1 | 0 | — / — / — / — (n=0) | — / — | — / — (n=0) | — (n=0) | 0 / 0 | — | — |
| none | 5 | 0.000 / 0.000 / 0.000 / 0.000 (n=5) | 0.004 / 0.002 | 0.000 / 0.000 (n=5) | 0.004 (n=5) | 0 / 5 | 11% | 12.62 |

#### tier t2, river (12 decisions)
| mode | n | EXCESS loss vs none: mean / median / p95 / max (bb) | loss vs none: mean / median | excess vs rel5: mean / median | loss under abs's EVs: mean | pick ≠ abs | class share: median | mass: median |
|---|---|---|---|---|---|---|---|---|
| abs | 12 | 0.001 / 0.000 / 0.000 / 0.022 (n=12) | 0.015 / 0.002 | -0.001 / 0.000 (n=12) | 0.017 (n=12) | 0 / 12 | 6% | 12.64 |
| rel5 | 12 | 0.001 / 0.000 / 0.003 / 0.019 (n=12) | 0.015 / 0.003 | 0.000 / 0.000 (n=12) | 0.018 (n=12) | 0 / 12 | 5% | 12.08 |
| rel1 | 0 | — / — / — / — (n=0) | — / — | — / — (n=0) | — (n=0) | 0 / 0 | — | — |
| none | 12 | 0.000 / 0.000 / 0.000 / 0.000 (n=12) | 0.014 / 0.004 | -0.002 / 0.000 (n=12) | 0.016 (n=12) | 0 / 12 | 5% | 12.64 |

#### tier t2, hero's natural weight natural / max < 1 % of his heaviest combo (3 decisions)
| mode | n | EXCESS loss vs none: mean / median / p95 / max (bb) | loss vs none: mean / median | excess vs rel5: mean / median | loss under abs's EVs: mean | pick ≠ abs | class share: median | mass: median |
|---|---|---|---|---|---|---|---|---|
| abs | 3 | -0.002 / -0.000 / 0.000 / 0.000 (n=3) | 0.001 / 0.001 | -0.003 / -0.003 (n=3) | 0.001 (n=3) | 0 / 3 | 11% | 3.89 |
| rel5 | 3 | 0.001 / 0.002 / 0.003 / 0.003 (n=3) | 0.003 / 0.003 | 0.000 / 0.000 (n=3) | 0.004 (n=3) | 0 / 3 | 2% | 3.17 |
| rel1 | 0 | — / — / — / — (n=0) | — / — | — / — (n=0) | — (n=0) | 0 / 0 | — | — |
| none | 3 | 0.000 / 0.000 / 0.000 / 0.000 (n=3) | 0.003 / 0.002 | -0.000 / -0.002 (n=3) | 0.003 (n=3) | 0 / 3 | 0% | 3.04 |

#### tier t2, hero's natural weight 1-10 % of his heaviest combo (2 decisions)
| mode | n | EXCESS loss vs none: mean / median / p95 / max (bb) | loss vs none: mean / median | excess vs rel5: mean / median | loss under abs's EVs: mean | pick ≠ abs | class share: median | mass: median |
|---|---|---|---|---|---|---|---|---|
| abs | 2 | 0.000 / 0.001 / 0.001 / 0.001 (n=2) | 0.003 / 0.004 | 0.000 / 0.001 (n=2) | 0.003 (n=2) | 0 / 2 | 18% | 13.54 |
| rel5 | 2 | 0.000 / 0.000 / 0.000 / 0.000 (n=2) | 0.003 / 0.003 | 0.000 / 0.000 (n=2) | 0.002 (n=2) | 0 / 2 | 6% | 13.16 |
| rel1 | 0 | — / — / — / — (n=0) | — / — | — / — (n=0) | — (n=0) | 0 / 0 | — | — |
| none | 2 | 0.000 / 0.000 / 0.000 / 0.000 (n=2) | 0.003 / 0.003 | 0.000 / 0.000 (n=2) | 0.002 (n=2) | 0 / 2 | 6% | 13.16 |

#### tier t2, hero's natural weight 10-50 % of his heaviest combo (7 decisions)
| mode | n | EXCESS loss vs none: mean / median / p95 / max (bb) | loss vs none: mean / median | excess vs rel5: mean / median | loss under abs's EVs: mean | pick ≠ abs | class share: median | mass: median |
|---|---|---|---|---|---|---|---|---|
| abs | 7 | -0.000 / 0.000 / 0.000 / 0.000 (n=7) | 0.009 / 0.004 | -0.000 / 0.000 (n=7) | 0.009 (n=7) | 0 / 7 | 6% | 13.52 |
| rel5 | 7 | -0.000 / 0.000 / 0.000 / 0.000 (n=7) | 0.009 / 0.003 | 0.000 / 0.000 (n=7) | 0.009 (n=7) | 0 / 7 | 6% | 13.52 |
| rel1 | 0 | — / — / — / — (n=0) | — / — | — / — (n=0) | — (n=0) | 0 / 0 | — | — |
| none | 7 | 0.000 / 0.000 / 0.000 / 0.000 (n=7) | 0.009 / 0.004 | 0.000 / 0.000 (n=7) | 0.009 (n=7) | 0 / 7 | 5% | 13.52 |

#### tier t2, hero's natural weight ≥ 50 % of his heaviest combo (7 decisions)
| mode | n | EXCESS loss vs none: mean / median / p95 / max (bb) | loss vs none: mean / median | excess vs rel5: mean / median | loss under abs's EVs: mean | pick ≠ abs | class share: median | mass: median |
|---|---|---|---|---|---|---|---|---|
| abs | 7 | 0.003 / 0.000 / 0.022 / 0.022 (n=7) | 0.021 / 0.018 | 0.000 / 0.000 (n=7) | 0.026 (n=7) | 0 / 7 | 6% | 15.56 |
| rel5 | 7 | 0.002 / 0.000 / 0.019 / 0.019 (n=7) | 0.020 / 0.018 | 0.000 / 0.000 (n=7) | 0.025 (n=7) | 0 / 7 | 6% | 15.53 |
| rel1 | 0 | — / — / — / — (n=0) | — / — | — / — (n=0) | — (n=0) | 0 / 0 | — | — |
| none | 7 | 0.000 / 0.000 / 0.000 / 0.000 (n=7) | 0.019 / 0.018 | -0.003 / 0.000 (n=7) | 0.022 (n=7) | 0 / 7 | 6% | 15.61 |

#### tier t3, all (10 decisions)
| mode | n | EXCESS loss vs none: mean / median / p95 / max (bb) | loss vs none: mean / median | excess vs rel5: mean / median | loss under abs's EVs: mean | pick ≠ abs | class share: median | mass: median |
|---|---|---|---|---|---|---|---|---|
| abs | 10 | -0.000 / 0.000 / 0.000 / 0.000 (n=10) | 0.012 / 0.001 | -0.000 / 0.000 (n=10) | 0.012 (n=10) | 0 / 10 | 1% | 234.33 |
| rel5 | 10 | 0.000 / 0.000 / 0.000 / 0.000 (n=10) | 0.012 / 0.002 | 0.000 / 0.000 (n=10) | 0.012 (n=10) | 0 / 10 | 1% | 234.33 |
| rel1 | 0 | — / — / — / — (n=0) | — / — | — / — (n=0) | — (n=0) | 0 / 0 | — | — |
| none | 10 | 0.000 / 0.000 / 0.000 / 0.000 (n=10) | 0.012 / 0.002 | 0.000 / 0.000 (n=10) | 0.012 (n=10) | 0 / 10 | 1% | 234.33 |

## Reproduction (abs vs the live trace)
- decisions whose abs walk used the live tree on every street: 107 — reproduced (mass and class within rounding, same pick): 105; differing: 2 (13567, 14991)
- decisions re-solved under today's menus (no live tree in the cache / the menus changed since): 75; not comparable: 1

## Readability of a near-zero-weight hero combo (mode none)
- abs: 182 nodes read; mix sums outside [0.99, 1.01]: 0; nodes with no non-zero finite EV: 0; hero weight at the node < 1e-3 (check #17's absent bound): 4
- rel5: 183 nodes read; mix sums outside [0.99, 1.01]: 0; nodes with no non-zero finite EV: 0; hero weight at the node < 1e-3 (check #17's absent bound): 12
- rel1: 89 nodes read; mix sums outside [0.99, 1.01]: 0; nodes with no non-zero finite EV: 0; hero weight at the node < 1e-3 (check #17's absent bound): 12
- none: 183 nodes read; mix sums outside [0.99, 1.01]: 0; nodes with no non-zero finite EV: 0; hero weight at the node < 1e-3 (check #17's absent bound): 16

## Requests
- by mode (latest walk per decision): abs 581, none 341, rel5 141, rel1 115; every row ever written (re-runs included): 1178
- trees CREATED by mode: none 72, abs 119, rel5 30, rel1 9

## Per-decision table
regime a = hero's natural weight (mode none, before its epsilon) > 1e-4 × his heaviest live combo; b = he deviated. excess(ref) = best-response loss of the mode's mix under ref's EVs MINUS ref's own regret under its EVs (a QRE mix is never a pure best response), bb. "repro" = the abs walk against the live trace (decision-street hero mass, class mass, mix, pick).
| answer | hand | tier | st | hero | pos | reg | natural w | nat/max | mass abs | mass rel5 | mass rel1 | mass none | share abs | share rel5 | share rel1 | share none | pick abs | pick rel5 | pick rel1 | pick none | excess(none) abs | excess(none) rel5 | excess(none) rel1 | excess(none) none | excess(rel5) abs | excess(rel5) rel5 | excess(rel5) rel1 | excess(rel5) none | none under abs EVs | repro |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 9647 | 4921735323 | t1 | flop | KhKs | CO | a | 0.0141 | 61% | 4.08 | 3.86 | 3.86 | 3.86 | 7% | 2% | 2% | 2% | CHECK | CHECK | CHECK | CHECK | 0.001 | 0.000 | 0.000 | 0.000 | 0.001 | 0.000 | 0.000 | 0.000 | 0.002 | ok · re-solved (bet_sizes.allin_threshold: live 60 / walk 100) · mass Δ0.000 class Δ0.0000 mix Δ0.006 |
| 9651 | 4921735323 | t1 | turn | KhKs | CO | a | 0.0141 | 84% | 1.84 | 1.51 | 1.51 | 1.51 | 16% | 6% | 6% | 6% | CHECK | CHECK | CHECK | CHECK | 0.004 | 0.000 | 0.000 | 0.000 | 0.004 | 0.000 | 0.000 | 0.000 | 0.001 | DIFF · re-solved (bet_sizes.allin_threshold: live 60 / walk 100) · mass Δ0.276 class Δ0.0000 mix Δ0.000 |
| 9654 | 4921735323 | t1 | river | KhKs | CO | a | 0.0135 | 100% | 1.05 | 0.67 | 0.67 | 0.67 | 29% | 9% | 9% | 9% | FOLD | CALL * | CALL * | CALL * | 2.619 | 0.000 | 0.000 | 0.000 | 2.619 | 0.000 | 0.000 | 0.000 | 0.060 | DIFF · re-solved (bet_sizes.allin_threshold: live 60 / walk 100) · mass Δ0.503 class Δ0.0000 mix Δ0.045 |
| 10273 | 4922086692 | t1 | flop | Ah5h | HJ | a | 0.0024 | 13% | 1.44 | 1.25 | 1.25 | 1.25 | 14% | 1% | 1% | 1% | BET | CHECK * | CHECK * | CHECK * | 0.007 | 0.000 | 0.000 | 0.000 | 0.007 | 0.000 | 0.000 | 0.000 | 0.031 | DIFF · re-solved (bet_sizes.allin_threshold: live 60 / walk 100) · mass Δ0.000 class Δ0.0000 mix Δ0.680 pick live CHECK / walk BET |
| 10274 | 4922086692 | t1 | flop | Ah5h | HJ | a | 0.0024 | 13% | 1.44 | 1.25 | 1.25 | 1.25 | 14% | 1% | 1% | 1% | CALL | CALL | CALL | CALL | -0.000 | 0.000 | 0.000 | 0.000 | -0.000 | 0.000 | 0.000 | 0.000 | 0.012 | ok · re-solved (bet_sizes.allin_threshold: live 60 / walk 100) · mass Δ0.000 class Δ0.0000 mix Δ0.174 |
| 10275 | 4922086692 | t1 | turn | Ah5h | HJ | a | 0.0000 | 7% | 0.20 | 0.01 | 0.01 | 0.01 | 98% | 1% | 1% | 0% | FOLD | FOLD | FOLD | FOLD | 0.093 | 0.000 | 0.000 | 0.000 | 0.097 | 0.000 | 0.000 | 0.000 | 0.000 | DIFF · re-solved (bet_sizes.allin_threshold: live 60 / walk 100) · mass Δ0.228 class Δ0.0000 mix Δ0.006 |
| 10803 (chain) | 4922268032 | t1 | flop | AdQs | BB | a | 0.8497 | 85% | 175.34 | 175.34 | 175.34 | 175.34 | 4% | 4% | 4% | 4% | CHECK | CHECK | CHECK | CHECK | 0.000 | 0.000 | 0.000 | 0.000 | 0.000 | 0.000 | 0.000 | 0.000 | 0.001 | ok · re-solved (bet_sizes.street_bet_sizes.0.position_bet_sizes.0.) · mass Δ0.000 class Δ0.0000 mix Δ0.000 |
| 10805 (chain) | 4922268032 | t1 | flop | AdQs | BB | a | 0.8497 | 85% | 175.34 | 175.34 | 175.34 | 175.34 | 4% | 4% | 4% | 4% | CALL | CALL | CALL | CALL | 0.000 | 0.000 | 0.000 | 0.000 | 0.000 | 0.000 | 0.000 | 0.000 | 0.003 | ok · re-solved (bet_sizes.street_bet_sizes.0.position_bet_sizes.0.) · mass Δ0.000 class Δ0.0000 mix Δ0.049 |
| 10806 (chain) | 4922268032 | t1 | turn | AdQs | BB | a | 0.8018 | 81% | 55.62 | 55.62 | 55.62 | 55.62 | 12% | 12% | 12% | 12% | CHECK | CHECK | CHECK | CHECK | 0.000 | 0.000 | 0.000 | 0.000 | 0.000 | 0.000 | 0.000 | 0.000 | 0.000 | DIFF · re-solved (bet_sizes.street_bet_sizes.0.position_bet_sizes.0.) · mass Δ2.452 class Δ0.1257 mix Δ0.001 |
| 10807 (chain) | 4922268032 | t1 | turn | AdQs | BB | a | 0.8018 | 81% | 55.62 | 55.62 | 55.62 | 55.62 | 12% | 12% | 12% | 12% | CALL | CALL | CALL | CALL | 0.000 | 0.000 | 0.000 | 0.000 | 0.000 | 0.000 | 0.000 | 0.000 | 0.002 | DIFF · re-solved (bet_sizes.street_bet_sizes.0.position_bet_sizes.0.) · mass Δ2.452 class Δ0.1257 mix Δ0.001 |
| 10808 | 4922268032 | t1 | river | AdQs | BB | a | 0.7927 | 80% | 40.82 | 40.82 | 40.82 | 40.82 | 16% | 16% | 16% | 16% | CHECK | CHECK | CHECK | CHECK | 0.000 | 0.000 | 0.000 | 0.000 | 0.000 | 0.000 | 0.000 | 0.000 | 0.003 | DIFF · re-solved (bet_sizes.street_bet_sizes.0.position_bet_sizes.0.) · mass Δ38.888 class Δ6.0643 mix Δ0.015 |
| 10843 | 4922269408 | t1 | flop | AdQc | UTG | a | 0.0001 | 0% | 3.16 | 2.67 | 2.58 | 2.56 | 19% | 4% | 1% | 0% | FOLD | CALL * | CALL * | CALL * | 2.677 | 0.002 | 0.000 | 0.000 | 1.413 | 0.000 | -0.001 | -0.001 | 0.000 | ok · re-solved (bet_sizes.street_bet_sizes.0.position_bet_sizes.0.) · mass Δ0.000 class Δ0.0000 mix Δ0.036 |
| 10851 (chain) | 4922269763 | t2 | flop | Ac8c | CO | a | 1.0000 | 100% | 333.54 | 333.54 | — | 333.54 | 1% | 1% | — | 1% | BET | BET | — | BET | 0.000 | 0.000 | — | 0.000 | 0.000 | 0.000 | — | 0.000 | 0.008 | ok · re-solved (bet_sizes.street_bet_sizes.0.position_bet_sizes.0.) · mass Δ0.000 class Δ0.0000 mix Δ0.870 |
| 10852 (chain) | 4922269763 | t2 | turn | Ac8c | CO | a | 0.3585 | 96% | 64.93 | 64.93 | — | 64.93 | 2% | 2% | — | 2% | RAISE | RAISE | — | RAISE | 0.000 | 0.000 | — | 0.000 | 0.000 | 0.000 | — | 0.000 | 0.121 | DIFF · re-solved (bet_sizes.street_bet_sizes.0.position_bet_sizes.0.) · mass Δ152.155 class Δ2.5654 mix Δ0.473 |
| 10853 | 4922269763 | t2 | river | Ac8c | CO | a | 0.1960 | 55% | 6.22 | 6.12 | — | 6.07 | 6% | 4% | — | 3% | ALLIN | ALLIN | — | ALLIN | 0.022 | 0.019 | — | 0.000 | 0.001 | 0.000 | — | -0.021 | 0.045 | DIFF · re-solved (bet_sizes.street_bet_sizes.0.position_bet_sizes.0.) · mass Δ13.547 class Δ0.3005 mix Δ0.086 |
| 11032 (chain) | 4922277663 | t2 | flop | JhAh | BB | a | 0.3301 | 84% | 19.10 | 19.10 | — | 19.10 | 7% | 7% | — | 7% | CHECK | CHECK | — | CHECK | 0.000 | 0.000 | — | 0.000 | 0.000 | 0.000 | — | 0.000 | 0.033 | ok · re-solved (bet_sizes.street_bet_sizes.0.position_bet_sizes.0.) · mass Δ0.000 class Δ0.0000 mix Δ0.184 |
| 11033 | 4922277663 | t2 | turn | JhAh | BB | a | 0.0030 | 7% | 1.13 | 0.98 | — | 0.98 | 18% | 6% | — | 6% | CHECK | CHECK | — | CHECK | -0.001 | 0.000 | — | 0.000 | -0.001 | 0.000 | — | 0.000 | 0.002 | DIFF · re-solved (bet_sizes.street_bet_sizes.0.position_bet_sizes.0.) · mass Δ7.602 class Δ0.2930 mix Δ0.001 |
| 11034 (chain) | 4922277663 | t2 | turn | JhAh | BB | a | 0.0030 | 7% | 1.13 | 0.98 | — | 0.98 | 18% | 6% | — | 6% | FOLD | FOLD | — | FOLD | 0.002 | 0.000 | — | 0.000 | 0.002 | 0.000 | — | 0.000 | 0.004 | DIFF · re-solved (bet_sizes.street_bet_sizes.0.position_bet_sizes.0.) · mass Δ7.602 class Δ0.2930 mix Δ0.001 |
| 11374 (chain) | 4922298483 | t1 | flop | 2d2h | SB | a | 0.4282 | 62% | 25.19 | 25.19 | 25.19 | 25.19 | 5% | 5% | 5% | 5% | BET | BET | BET | BET | 0.000 | 0.000 | 0.000 | 0.000 | 0.000 | 0.000 | 0.000 | 0.000 | 0.035 | ok · re-solved (bet_sizes.street_bet_sizes.0.position_bet_sizes.0.) · mass Δ0.000 class Δ0.0000 mix Δ0.579 |
| 11376 (chain) | 4922298483 | t1 | flop | 2d2h | SB | a | 0.4282 | 62% | 25.19 | 25.19 | 25.19 | 25.19 | 5% | 5% | 5% | 5% | RAISE | RAISE | RAISE | RAISE | 0.000 | 0.000 | 0.000 | 0.000 | 0.000 | 0.000 | 0.000 | 0.000 | 0.012 | ok · re-solved (bet_sizes.street_bet_sizes.0.position_bet_sizes.0.) · mass Δ0.000 class Δ0.0000 mix Δ0.040 |
| 11378 | 4922298483 | t1 | turn | 2d2h | SB | a | 0.0273 | 45% | 0.81 | 0.74 | 0.74 | 0.74 | 18% | 11% | 11% | 11% | BET | BET | BET | BET | -0.000 | 0.000 | 0.000 | 0.000 | -0.000 | 0.000 | 0.000 | 0.000 | 0.024 | DIFF · re-solved (bet_sizes.street_bet_sizes.0.position_bet_sizes.0.) · mass Δ1.481 class Δ0.0289 mix Δ0.770 |
| 11380 | 4922298483 | t1 | turn | 2d2h | SB | a | 0.0273 | 45% | 0.81 | 0.74 | 0.74 | 0.74 | 18% | 11% | 11% | 11% | ALLIN | ALLIN | ALLIN | ALLIN | 0.125 | 0.000 | 0.000 | 0.000 | 0.125 | 0.000 | 0.000 | 0.000 | 0.959 | DIFF · re-solved (bet_sizes.street_bet_sizes.0.position_bet_sizes.0.) · mass Δ1.481 class Δ0.0289 mix Δ0.742 pick live RAISE 73.1 / walk ALLIN |
| 11381 | 4922298483 | t1 | turn | 2d2h | SB | a | 0.0462 | 48% | 1.28 | 1.25 | 1.25 | 1.25 | 12% | 10% | 10% | 10% | CALL | CALL | CALL | CALL | 0.000 | 0.000 | 0.000 | 0.000 | 0.000 | 0.000 | 0.000 | 0.000 | 0.000 | DIFF · re-solved (bet_sizes.street_bet_sizes.0.position_bet_sizes.0.) · mass Δ0.304 class Δ0.0000 mix Δ0.000 |
| 11382 | 4922298483 | t1 | river | 2d2h | SB | a | 0.0001 | 12% | 0.16 | 0.01 | 0.01 | 0.01 | 94% | 4% | 4% | 4% | CHECK | CHECK | CHECK | CHECK | 0.035 | 0.000 | 0.000 | 0.000 | 0.035 | 0.000 | 0.000 | 0.000 | 0.036 | ok · re-solved (bet_sizes.street_bet_sizes.0.position_bet_sizes.0.) · mass Δ0.010 class Δ0.0000 mix Δ0.003 |
| 11401 (chain) | 4922299158 | t1 | flop | QhQs | SB | a | 0.3332 | 86% | 16.07 | 16.07 | 16.07 | 16.07 | 12% | 12% | 12% | 12% | BET | BET | BET | BET | 0.000 | 0.000 | 0.000 | 0.000 | 0.000 | 0.000 | 0.000 | 0.000 | 0.010 | ok · re-solved (bet_sizes.street_bet_sizes.0.position_bet_sizes.0.) · mass Δ0.000 class Δ0.0000 mix Δ0.985 |
| 11403 (chain) | 4922299158 | t1 | flop | QhQs | SB | a | 0.3332 | 86% | 16.07 | 16.07 | 16.07 | 16.07 | 12% | 12% | 12% | 12% | ALLIN | ALLIN | ALLIN | ALLIN | 0.000 | 0.000 | 0.000 | 0.000 | 0.000 | 0.000 | 0.000 | 0.000 | 0.011 | DIFF · re-solved (bet_sizes.street_bet_sizes.0.position_bet_sizes.0.) · mass Δ0.000 class Δ0.0000 mix Δ0.956 pick live FOLD / walk ALLIN |
| 11404 | 4922299158 | t1 | turn | QhQs | SB | a | 0.0004 | 73% | 0.30 | 0.00 | 0.00 | 0.00 | 99% | 11% | 10% | 10% | ALLIN | ALLIN | ALLIN | ALLIN | -0.009 | 0.001 | 0.001 | 0.000 | -0.009 | 0.000 | -0.001 | -0.001 | 0.018 | DIFF · re-solved (bet_sizes.street_bet_sizes.0.position_bet_sizes.0.) · mass Δ1.010 class Δ0.0000 mix Δ0.992 pick live CHECK / walk ALLIN |
| 11405 (chain) | 4922299158 | t1 | turn | QhQs | SB | a | 0.3332 | 86% | 15.12 | 15.12 | 15.12 | 15.12 | 13% | 13% | 13% | 13% | ALLIN | ALLIN | ALLIN | ALLIN | 0.000 | 0.000 | 0.000 | 0.000 | 0.000 | 0.000 | 0.000 | 0.000 | 0.000 | ok · re-solved (bet_sizes.street_bet_sizes.0.position_bet_sizes.0.) · mass Δ0.000 class Δ0.0000 mix Δ0.000 |
| 11406 | 4922299158 | t1 | turn | QhQs | SB | a | 0.0004 | 73% | 0.30 | 0.00 | 0.00 | 0.00 | 99% | 11% | 10% | 10% | CALL | CALL | CALL | CALL | -0.075 | -0.033 | -0.010 | 0.000 | -0.068 | 0.000 | 0.038 | 0.054 | 0.231 | DIFF · re-solved (bet_sizes.street_bet_sizes.0.position_bet_sizes.0.) · mass Δ1.010 class Δ0.0000 mix Δ0.098 |
| 11425 (chain) | 4922299692 | t1 | flop | AdKs | UTG | a | 1.0000 | 100% | 211.83 | 211.83 | 211.83 | 211.83 | 6% | 6% | 6% | 6% | CHECK | CHECK | CHECK | CHECK | 0.000 | 0.000 | 0.000 | 0.000 | 0.000 | 0.000 | 0.000 | 0.000 | 0.004 | ok · re-solved (bet_sizes.street_bet_sizes.0.position_bet_sizes.0.) · mass Δ0.000 class Δ0.0000 mix Δ0.059 |
| 11426 | 4922299692 | t1 | turn | AdKs | UTG | a | 0.0010 | 30% | 0.66 | 0.07 | 0.07 | 0.07 | 91% | 17% | 17% | 17% | CHECK | CHECK | CHECK | CHECK | -0.004 | 0.000 | 0.000 | 0.000 | -0.004 | 0.000 | 0.000 | 0.000 | 0.020 | DIFF · re-solved (bet_sizes.street_bet_sizes.0.position_bet_sizes.0.) · mass Δ1.980 class Δ0.0000 mix Δ0.003 |
| 11427 | 4922299692 | t1 | river | AdKs | UTG | a | 0.0010 | 62% | 0.66 | 0.04 | 0.04 | 0.04 | 91% | 29% | 29% | 29% | CHECK | CHECK | CHECK | CHECK | -0.000 | 0.000 | 0.000 | 0.000 | -0.000 | 0.000 | 0.000 | 0.000 | 0.001 | DIFF · re-solved (bet_sizes.street_bet_sizes.0.position_bet_sizes.0.) · mass Δ0.887 class Δ0.0000 mix Δ0.001 |
| 12071 (chain) | 4922311523 | t1 | flop | QcAd | BTN | a | 0.5492 | 56% | 57.83 | 57.83 | 57.83 | 57.83 | 11% | 11% | 11% | 11% | CHECK | CHECK | CHECK | CHECK | 0.000 | 0.000 | 0.000 | 0.000 | 0.000 | 0.000 | 0.000 | 0.000 | 0.003 | ok · re-solved (bet_sizes.street_bet_sizes.0.position_bet_sizes.0.) · mass Δ0.000 class Δ0.0000 mix Δ0.278 |
| 12072 (chain) | 4922311523 | t1 | turn | QcAd | BTN | a | 0.2866 | 34% | 22.21 | 22.21 | 22.21 | 22.21 | 11% | 11% | 11% | 11% | RAISE | RAISE | RAISE | RAISE | 0.000 | 0.000 | 0.000 | 0.000 | 0.000 | 0.000 | 0.000 | 0.000 | 0.042 | DIFF · re-solved (bet_sizes.street_bet_sizes.0.position_bet_sizes.0.) · mass Δ0.287 class Δ0.0620 mix Δ0.022 |
| 12074 (chain) | 4922311523 | t1 | turn | QcAd | BTN | a | 0.2866 | 34% | 22.21 | 22.21 | 22.21 | 22.21 | 11% | 11% | 11% | 11% | CALL | CALL | CALL | CALL | 0.000 | 0.000 | 0.000 | 0.000 | 0.000 | 0.000 | 0.000 | 0.000 | 0.017 | DIFF · re-solved (bet_sizes.street_bet_sizes.0.position_bet_sizes.0.) · mass Δ0.287 class Δ0.0620 mix Δ0.169 |
| 12075 | 4922311523 | t1 | river | QcAd | BTN | a | 0.2567 | 56% | 4.62 | 4.51 | 4.44 | 4.43 | 25% | 23% | 22% | 22% | CALL | CALL | CALL | CALL | 0.000 | 0.000 | 0.000 | 0.000 | 0.000 | 0.000 | 0.000 | 0.000 | 0.000 | DIFF · re-solved (bet_sizes.street_bet_sizes.0.position_bet_sizes.0.) · mass Δ1.499 class Δ0.0574 mix Δ0.000 |
| 12356 (chain) | 4922342828 | t2 | flop | 9cAd | CO | a | 0.8426 | 84% | 357.45 | 357.45 | — | 357.45 | 3% | 3% | — | 3% | CHECK | CHECK | — | CHECK | 0.000 | 0.000 | — | 0.000 | 0.000 | 0.000 | — | 0.000 | 0.008 | ok · re-solved (bet_sizes.street_bet_sizes.0.position_bet_sizes.0.) · mass Δ0.000 class Δ0.0000 mix Δ0.493 |
| 12358 (chain) | 4922342828 | t2 | turn | 9cAd | CO | a | 0.0534 | 29% | 8.66 | 8.29 | — | 8.21 | 8% | 4% | — | 3% | BET | BET | — | BET | 0.029 | 0.002 | — | 0.000 | 0.011 | 0.000 | — | 0.002 | 0.025 | DIFF · re-solved (bet_sizes.street_bet_sizes.0.position_bet_sizes.0.) · mass Δ10.175 class Δ0.2147 mix Δ0.456 pick live CHECK / walk BET |
| 12360 | 4922342828 | t2 | river | 9cAd | CO | a | 0.0002 | 0% | 3.89 | 3.17 | — | 3.04 | 15% | 2% | — | 0% | CHECK | CHECK | — | CHECK | -0.005 | -0.002 | — | 0.000 | -0.003 | 0.000 | — | 0.004 | 0.008 | DIFF · re-solved (bet_sizes.street_bet_sizes.0.position_bet_sizes.0.) · mass Δ3.048 class Δ0.0494 mix Δ0.002 |
| 12553 | 4922366616 | t2 | flop | KdQc | BB | a | 0.0184 | 10% | 13.54 | 13.16 | — | 13.16 | 4% | 2% | — | 2% | CHECK | CHECK | — | CHECK | 0.001 | 0.000 | — | 0.000 | 0.001 | 0.000 | — | 0.000 | 0.003 | ok · re-solved (bet_sizes.street_bet_sizes.0.position_bet_sizes.0.) · mass Δ0.000 class Δ0.0000 mix Δ0.021 |
| 12554 (chain) | 4922366616 | t2 | flop | KdQc | BB | a | 0.0184 | 10% | 13.54 | 13.16 | — | 13.16 | 4% | 2% | — | 2% | FOLD | FOLD | — | FOLD | -0.002 | 0.000 | — | 0.000 | -0.002 | 0.000 | — | 0.000 | 0.002 | ok · re-solved (bet_sizes.street_bet_sizes.0.position_bet_sizes.0.) · mass Δ0.000 class Δ0.0000 mix Δ0.000 |
| 12581 | 4922367798 | t2 | flop | AcKc | SB | a | 0.3121 | 86% | 16.62 | 16.62 | — | 16.62 | 6% | 6% | — | 6% | BET | BET | — | BET | 0.000 | 0.000 | — | 0.000 | 0.000 | 0.000 | — | 0.000 | 0.018 | ok · re-solved (bet_sizes.street_bet_sizes.0.position_bet_sizes.0.) · mass Δ0.000 class Δ0.0000 mix Δ0.940 |
| 12582 (chain) | 4922367798 | t2 | turn | AcKc | SB | a | 0.0137 | 65% | 0.65 | 0.54 | — | 0.54 | 23% | 9% | — | 9% | CHECK | BET * | — | BET * | 0.012 | 0.000 | — | 0.000 | 0.012 | 0.000 | — | 0.000 | 0.020 | DIFF · re-solved (bet_sizes.street_bet_sizes.0.position_bet_sizes.0.) · mass Δ11.375 class Δ0.7855 mix Δ0.470 |
| 12584 (chain) | 4922367798 | t2 | turn | AcKc | SB | a | 0.0137 | 65% | 0.65 | 0.54 | — | 0.54 | 23% | 9% | — | 9% | CALL | ALLIN * | — | ALLIN * | 1.659 | 0.000 | — | 0.000 | 1.659 | 0.000 | — | 0.000 | 0.983 | DIFF · re-solved (bet_sizes.street_bet_sizes.0.position_bet_sizes.0.) · mass Δ11.375 class Δ0.7855 mix Δ0.399 pick live FOLD / walk CALL |
| 12664 (chain) | 4922370692 | t2 | flop | QcQd | SB | a | 0.5155 | 76% | 40.61 | 40.61 | — | 40.61 | 8% | 8% | — | 8% | CHECK | CHECK | — | CHECK | 0.000 | 0.000 | — | 0.000 | 0.000 | 0.000 | — | 0.000 | 0.032 | DIFF · re-solved (bet_sizes.street_bet_sizes.0.position_bet_sizes.0.) · mass Δ0.000 class Δ0.0000 mix Δ0.693 pick live BET / walk CHECK |
| 12665 (chain) | 4922370692 | t2 | turn | QcQd | SB | a | 0.1831 | 38% | 14.07 | 14.07 | — | 14.07 | 4% | 4% | — | 4% | BET | BET | — | BET | 0.000 | 0.000 | — | 0.000 | 0.000 | 0.000 | — | 0.000 | 0.030 | DIFF · re-solved (bet_sizes.street_bet_sizes.0.position_bet_sizes.0.) · mass Δ6.350 class Δ0.5184 mix Δ0.820 |
| 12667 | 4922370692 | t2 | river | QcQd | SB | a | 0.1773 | 43% | 10.40 | 10.40 | — | 10.40 | 5% | 5% | — | 5% | CHECK | CHECK | — | CHECK | 0.000 | 0.000 | — | 0.000 | 0.000 | 0.000 | — | 0.000 | 0.038 | DIFF · re-solved (bet_sizes.street_bet_sizes.0.position_bet_sizes.0.) · mass Δ6.468 class Δ0.3929 mix Δ0.327 |
| 12668 (chain) | 4922370692 | t2 | river | QcQd | SB | a | 0.1773 | 43% | 10.40 | 10.40 | — | 10.40 | 5% | 5% | — | 5% | CALL | CALL | — | CALL | 0.000 | 0.000 | — | 0.000 | 0.000 | 0.000 | — | 0.000 | 0.000 | DIFF · re-solved (bet_sizes.street_bet_sizes.0.position_bet_sizes.0.) · mass Δ6.468 class Δ0.3929 mix Δ0.000 |
| 12693 (chain) | 4922371624 | t1 | flop | KdQd | BB | a | 0.1216 | 74% | 8.96 | 8.96 | 8.96 | 8.96 | 5% | 5% | 5% | 5% | CHECK | CHECK | CHECK | CHECK | 0.000 | 0.000 | 0.000 | 0.000 | 0.000 | 0.000 | 0.000 | 0.000 | 0.008 | ok · re-solved (bet_sizes.street_bet_sizes.0.position_bet_sizes.0.) · mass Δ0.000 class Δ0.0000 mix Δ0.207 |
| 12694 | 4922371624 | t1 | turn | KdQd | BB | a | 0.0090 | 32% | 1.08 | 0.95 | 0.95 | 0.95 | 18% | 7% | 7% | 7% | CHECK | CHECK | CHECK | CHECK | 0.003 | 0.000 | 0.000 | 0.000 | 0.003 | 0.000 | 0.000 | 0.000 | 0.018 | DIFF · re-solved (bet_sizes.street_bet_sizes.0.position_bet_sizes.0.) · mass Δ2.681 class Δ0.0755 mix Δ0.083 |
| 12695 | 4922371624 | t1 | river | KdQd | BB | a | 0.0077 | 38% | 0.84 | 0.56 | 0.56 | 0.56 | 24% | 9% | 9% | 9% | CHECK | CHECK | CHECK | CHECK | 0.007 | 0.000 | 0.000 | 0.000 | 0.007 | 0.000 | 0.000 | 0.000 | 0.002 | DIFF · re-solved (bet_sizes.street_bet_sizes.0.position_bet_sizes.0.) · mass Δ2.011 class Δ0.0411 mix Δ0.135 |
| 12800 (chain) | 4922375825 | t1 | flop | QhAs | BB | a | 0.0262 | 15% | 13.52 | 13.24 | 13.24 | 13.24 | 4% | 2% | 2% | 2% | BET | BET | BET | BET | 0.003 | 0.000 | 0.000 | 0.000 | 0.003 | 0.000 | 0.000 | 0.000 | 0.006 | ok · re-solved (bet_sizes.street_bet_sizes.0.position_bet_sizes.0.) · mass Δ0.000 class Δ0.0000 mix Δ0.707 |
| 12802 | 4922375825 | t1 | turn | QhAs | BB | a | 0.0041 | 25% | 1.49 | 0.71 | 0.71 | 0.71 | 40% | 3% | 3% | 3% | CHECK | BET * | BET * | BET * | -0.007 | 0.001 | 0.000 | 0.000 | -0.003 | 0.000 | -0.001 | -0.001 | 0.212 | DIFF · re-solved (bet_sizes.street_bet_sizes.0.position_bet_sizes.0.) · mass Δ2.697 class Δ0.0000 mix Δ0.470 |
| 12803 | 4922375825 | t1 | river | QhAs | BB | a | 0.0008 | 9% | 1.40 | 0.38 | 0.38 | 0.38 | 43% | 3% | 2% | 2% | CHECK | BET * | BET * | BET * | 0.096 | -0.002 | 0.000 | 0.000 | 0.118 | 0.000 | 0.001 | 0.001 | 0.106 | DIFF · re-solved (bet_sizes.street_bet_sizes.0.position_bet_sizes.0.) · mass Δ2.078 class Δ0.0000 mix Δ0.590 pick live BET / walk CHECK |
| 13329 (chain) | 4923395601 | t2 | flop | KhAs | BB | a | 0.1637 | 19% | 13.36 | 13.36 | — | 13.36 | 15% | 15% | — | 15% | CHECK | CHECK | — | CHECK | 0.000 | 0.000 | — | 0.000 | 0.000 | 0.000 | — | 0.000 | 0.008 | ok · live tree · mass Δ0.000 class Δ0.0000 mix Δ0.000 |
| 13331 | 4923395601 | t2 | turn | KhAs | BB | a | 0.1552 | 18% | 12.35 | 12.35 | — | 12.35 | 11% | 11% | — | 11% | CHECK | CHECK | — | CHECK | 0.000 | 0.000 | — | 0.000 | 0.000 | 0.000 | — | 0.000 | 0.013 | ok · live tree · mass Δ0.000 class Δ0.0000 mix Δ0.000 |
| 13567 (chain) | 4923404416 | t2 | flop | ThTd | BTN | a | 0.8649 | 86% | 43.43 | 43.43 | — | 43.43 | 12% | 12% | — | 12% | RAISE | RAISE | — | RAISE | 0.000 | 0.000 | — | 0.000 | 0.000 | 0.000 | — | 0.000 | 0.009 | DIFF · live tree · mass Δ0.000 class Δ0.0000 mix Δ0.930 pick live CALL 4.6 / walk RAISE |
| 13568 (chain) | 4923404416 | t2 | turn | ThTd | BTN | a | 0.0132 | 1% | 20.97 | 20.97 | — | 20.89 | 5% | 5% | — | 5% | CHECK | CHECK | — | CHECK | 0.000 | -0.001 | — | 0.000 | 0.002 | 0.000 | — | 0.001 | 0.008 | DIFF · re-solved (players.0.range.weight: live 56.95 / walk 0.28) · mass Δ0.890 class Δ2.8988 mix Δ0.742 pick live BET 5.8 / walk CHECK |
| 13570 | 4923404416 | t2 | river | ThTd | BTN | a | 0.0001 | 0% | 2.67 | 2.93 | — | 2.91 | 11% | 6% | — | 5% | ALLIN | ALLIN | — | ALLIN | 0.000 | 0.002 | — | 0.000 | -0.002 | 0.000 | — | -0.002 | 0.001 | DIFF · re-solved (players.0.range.weight: live 56.95 / walk 0.28) · mass Δ11.308 class Δ2.4647 mix Δ0.001 |
| 13573 (chain) | 4923404587 | t1 | flop | 5c5d | CO | a | 0.7175 | 72% | 75.07 | 75.07 | 75.07 | 75.07 | 6% | 6% | 6% | 6% | BET | BET | BET | BET | 0.000 | 0.000 | 0.000 | 0.000 | 0.000 | 0.000 | 0.000 | 0.000 | 0.007 | ok · live tree · mass Δ0.000 class Δ0.0000 mix Δ0.000 |
| 13575 (chain) | 4923404587 | t1 | turn | 5c5d | CO | a | 0.0615 | 27% | 9.67 | 9.66 | 9.66 | 9.66 | 4% | 4% | 4% | 4% | CHECK | CHECK | CHECK | CHECK | 0.000 | 0.000 | 0.000 | 0.000 | 0.000 | 0.000 | 0.000 | 0.000 | 0.007 | ok · live tree · mass Δ0.000 class Δ0.0000 mix Δ0.000 |
| 13576 | 4923404587 | t1 | river | 5c5d | CO | a | 0.0597 | 38% | 2.81 | 2.76 | 2.76 | 2.76 | 12% | 10% | 10% | 10% | CHECK | CHECK | CHECK | CHECK | 0.001 | 0.000 | 0.000 | 0.000 | 0.001 | 0.000 | 0.000 | 0.000 | 0.001 | ok · live tree · mass Δ0.000 class Δ0.0000 mix Δ0.000 |
| 13587 | 4923404821 | t3 | flop | 9h7d | BB | a | 1.0000 | 100% | 1130.99 | 1130.99 | — | 1130.99 | 1% | 1% | — | 1% | CHECK | CHECK | — | CHECK | 0.000 | 0.000 | — | 0.000 | 0.000 | 0.000 | — | 0.000 | 0.000 | ok · live tree · mass Δ0.000 class Δ0.0000 mix Δ0.000 |
| 13588 (chain) | 4923404821 | t3 | turn | 9h7d | BB | a | 0.9999 | 100% | 1084.27 | 1084.27 | — | 1084.27 | 1% | 1% | — | 1% | CHECK | CHECK | — | CHECK | 0.000 | 0.000 | — | 0.000 | 0.000 | 0.000 | — | 0.000 | 0.000 | ok · re-solved (players.1.range.weight: live 34.77 / walk 0.49) · mass Δ0.007 class Δ0.0001 mix Δ0.008 |
| 13590 (chain) | 4923404821 | t3 | river | 9h7d | BB | a | 0.9895 | 99% | 897.28 | 897.28 | — | 897.28 | 1% | 1% | — | 1% | CHECK | CHECK | — | CHECK | 0.000 | 0.000 | — | 0.000 | 0.000 | 0.000 | — | 0.000 | 0.000 | DIFF · re-solved (players.1.range.weight: live 34.77 / walk 0.49) · mass Δ104.133 class Δ0.0252 mix Δ0.182 |
| 13591 (chain) | 4923404821 | t3 | river | 9h7d | BB | a | 0.9895 | 99% | 897.28 | 897.28 | — | 897.28 | 1% | 1% | — | 1% | CALL | CALL | — | CALL | 0.000 | 0.000 | — | 0.000 | 0.000 | 0.000 | — | 0.000 | 0.003 | DIFF · re-solved (players.1.range.weight: live 34.77 / walk 0.49) · mass Δ104.133 class Δ0.0252 mix Δ0.352 |
| 13613 (chain) | 4923405463 | t2 | flop | 9dTd | BB | a | 0.8904 | 89% | 1131.05 | 1131.05 | — | 1131.05 | 0% | 0% | — | 0% | CHECK | CHECK | — | CHECK | 0.000 | 0.000 | — | 0.000 | 0.000 | 0.000 | — | 0.000 | 0.001 | ok · live tree · mass Δ0.000 class Δ0.0000 mix Δ0.000 |
| 13615 (chain) | 4923405463 | t2 | flop | 9dTd | BB | a | 0.8904 | 89% | 1131.05 | 1131.05 | — | 1131.05 | 0% | 0% | — | 0% | RAISE | RAISE | — | RAISE | 0.000 | 0.000 | — | 0.000 | 0.000 | 0.000 | — | 0.000 | 0.002 | ok · live tree · mass Δ0.000 class Δ0.0000 mix Δ0.000 |
| 13616 (chain) | 4923405463 | t2 | turn | 9dTd | BB | a | 0.3767 | 60% | 41.41 | 41.39 | — | 41.37 | 2% | 2% | — | 2% | BET | BET | — | BET | 0.000 | -0.002 | — | 0.000 | 0.002 | 0.000 | — | 0.001 | 0.011 | ok · live tree · mass Δ0.006 class Δ0.0001 mix Δ0.000 |
| 13617 | 4923405463 | t2 | river | 9dTd | BB | a | 0.2766 | 63% | 18.32 | 18.52 | — | 17.99 | 3% | 3% | — | 3% | BET | BET | — | BET | -0.004 | -0.005 | — | 0.000 | -0.001 | 0.000 | — | 0.003 | 0.065 | ok · live tree · mass Δ0.003 class Δ0.0001 mix Δ0.000 |
| 13658 (chain) | 4923407014 | t2 | flop | 6c7c | SB | a | 0.2579 | 28% | 61.75 | 61.75 | — | 61.75 | 2% | 2% | — | 2% | CHECK | CHECK | — | CHECK | 0.000 | 0.000 | — | 0.000 | 0.000 | 0.000 | — | 0.000 | 0.001 | ok · live tree · mass Δ0.000 class Δ0.0000 mix Δ0.000 |
| 13659 (chain) | 4923407014 | t2 | turn | 6c7c | SB | a | 0.2576 | 28% | 59.23 | 59.23 | — | 59.23 | 1% | 1% | — | 1% | CHECK | CHECK | — | CHECK | 0.000 | 0.000 | — | 0.000 | 0.000 | 0.000 | — | 0.000 | 0.001 | ok · live tree · mass Δ0.001 class Δ0.0000 mix Δ0.000 |
| 13662 (chain) | 4923407014 | t2 | turn | 6c7c | SB | a | 0.2576 | 28% | 59.23 | 59.23 | — | 59.23 | 1% | 1% | — | 1% | CALL | CALL | — | CALL | 0.000 | 0.000 | — | 0.000 | 0.000 | 0.000 | — | 0.000 | 0.027 | ok · live tree · mass Δ0.001 class Δ0.0000 mix Δ0.000 |
| 13663 (chain) | 4923407014 | t2 | river | 6c7c | SB | a | 0.1811 | 31% | 13.52 | 13.52 | — | 13.52 | 2% | 2% | — | 2% | CHECK | CHECK | — | CHECK | 0.000 | 0.000 | — | 0.000 | 0.000 | 0.000 | — | 0.000 | 0.000 | ok · live tree · mass Δ0.002 class Δ0.0000 mix Δ0.000 |
| 13665 | 4923407014 | t2 | river | 6c7c | SB | a | 0.1811 | 31% | 13.52 | 13.52 | — | 13.52 | 2% | 2% | — | 2% | CALL | CALL | — | CALL | 0.000 | 0.000 | — | 0.000 | 0.000 | 0.000 | — | 0.000 | 0.002 | ok · live tree · mass Δ0.002 class Δ0.0000 mix Δ0.000 |
| 13827 (chain) | 4923436818 | t2 | flop | Qc6c | BTN | a | 0.9621 | 96% | 401.06 | 401.06 | — | 401.06 | 1% | 1% | — | 1% | FAIL: node: AI solve timed out on ultra-2 — 1  | CHECK * | — | CHECK * | — | 0.000 | — | 0.000 | — | 0.000 | — | 0.000 | — | abs FAILED: node: AI solve timed out on ultra-2 — 1 poll: 0 answered 204 (not solved yet), 1 answered with no decision, 0 failed (that account may have hit its daily solution limit, or the client lost connection). |
| 13829 (chain) | 4923436818 | t2 | turn | Qc6c | BTN | a | 0.1159 | 36% | 37.73 | 37.70 | — | 37.68 | 1% | 1% | — | 1% | CHECK | CHECK | — | CHECK | -0.002 | 0.001 | — | 0.000 | -0.004 | 0.000 | — | -0.003 | 0.004 | ok · live tree · mass Δ0.002 class Δ0.0000 mix Δ0.000 |
| 13830 | 4923436818 | t2 | river | Qc6c | BTN | a | 0.1152 | 51% | 15.56 | 15.53 | — | 15.61 | 2% | 2% | — | 1% | CHECK | CHECK | — | CHECK | 0.000 | -0.000 | — | 0.000 | 0.000 | 0.000 | — | 0.000 | 0.001 | ok · live tree · mass Δ0.000 class Δ0.0000 mix Δ0.000 |
| 14051 (chain) | 4923458636 | t1 | flop | 5s8s | BB | a | 0.2214 | 22% | 231.88 | 231.88 | 231.88 | 231.88 | 0% | 0% | 0% | 0% | CHECK | CHECK | CHECK | CHECK | 0.000 | 0.000 | 0.000 | 0.000 | 0.000 | 0.000 | 0.000 | 0.000 | 0.002 | ok · live tree · mass Δ0.000 class Δ0.0000 mix Δ0.000 |
| 14052 (chain) | 4923458636 | t1 | turn | 5s8s | BB | a | 0.2134 | 30% | 58.85 | 58.81 | 58.72 | 58.70 | 1% | 1% | 0% | 0% | CHECK | CHECK | CHECK | CHECK | -0.000 | 0.001 | 0.001 | 0.000 | -0.001 | 0.000 | -0.000 | -0.001 | 0.009 | ok · live tree · mass Δ0.002 class Δ0.0000 mix Δ0.000 |
| 14053 (chain) | 4923458636 | t1 | turn | 5s8s | BB | a | 0.2134 | 30% | 58.85 | 58.81 | 58.72 | 58.70 | 1% | 1% | 0% | 0% | FOLD | FOLD | RAISE * | FOLD | 0.002 | 0.005 | 0.015 | 0.000 | -0.002 | 0.000 | 0.011 | -0.005 | 0.013 | ok · live tree · mass Δ0.002 class Δ0.0000 mix Δ0.119 |
| 14054 | 4923458636 | t1 | river | 5s8s | BB | a | 0.0307 | 19% | 2.78 | 2.34 | 2.67 | 2.19 | 5% | 2% | 3% | 1% | CHECK | CHECK | CHECK | CHECK | 0.000 | -0.000 | -0.000 | 0.000 | 0.000 | 0.000 | 0.000 | 0.000 | 0.001 | DIFF · re-solved (players.0.range.weight: live 3.53 / walk 2.81) · mass Δ0.687 class Δ0.0089 mix Δ0.002 |
| 14055 | 4923458636 | t1 | river | 5s8s | BB | a | 0.0307 | 19% | 2.78 | 2.34 | 2.67 | 2.19 | 5% | 2% | 3% | 1% | FOLD | FOLD | FOLD | FOLD | 0.020 | 0.022 | 0.005 | 0.000 | -0.000 | 0.000 | -0.005 | -0.007 | 0.006 | DIFF · re-solved (players.0.range.weight: live 3.53 / walk 2.81) · mass Δ0.687 class Δ0.0089 mix Δ0.163 pick live CALL 17.2 / walk FOLD |
| 14187 (chain) | 4923465151 | t1 | flop | JcQc | BTN | a | 0.4438 | 45% | 47.99 | 47.99 | 47.99 | 47.99 | 4% | 4% | 4% | 4% | BET | BET | BET | BET | 0.000 | 0.000 | 0.000 | 0.000 | 0.000 | 0.000 | 0.000 | 0.000 | 0.009 | ok · live tree · mass Δ0.000 class Δ0.0000 mix Δ0.000 |
| 14188 (chain) | 4923465151 | t1 | turn | JcQc | BTN | a | 0.1196 | 23% | 15.74 | 15.72 | 15.71 | 15.71 | 2% | 2% | 2% | 2% | BET | BET | BET | BET | -0.001 | -0.001 | 0.000 | 0.000 | 0.001 | 0.000 | 0.001 | 0.001 | 0.003 | ok · live tree · mass Δ0.001 class Δ0.0001 mix Δ0.000 |
| 14190 | 4923465151 | t1 | river | JcQc | BTN | a | 0.1122 | 49% | 4.17 | 4.23 | 4.19 | 4.19 | 6% | 4% | 4% | 4% | BET | BET | BET | BET | 0.010 | 0.002 | 0.001 | 0.000 | 0.007 | 0.000 | -0.001 | -0.002 | 0.006 | ok · live tree · mass Δ0.000 class Δ0.0000 mix Δ0.000 |
| 14311 (chain) | 4923471608 | t2 | flop | QcJc | BTN | a | 0.5957 | 60% | 55.46 | 55.46 | — | 55.46 | 4% | 4% | — | 4% | CALL | CALL | — | CALL | 0.000 | 0.000 | — | 0.000 | 0.000 | 0.000 | — | 0.000 | 0.009 | ok · live tree · mass Δ0.000 class Δ0.0000 mix Δ0.040 |
| 14313 (chain) | 4923471608 | t2 | turn | QcJc | BTN | a | 0.5513 | 56% | 37.58 | 37.58 | — | 37.58 | 6% | 6% | — | 6% | CALL | CALL | — | CALL | 0.000 | 0.000 | — | 0.000 | 0.000 | 0.000 | — | 0.000 | 0.009 | DIFF · re-solved (players.0.range.weight: live 270.11 / walk 8.87) · mass Δ4.579 class Δ0.1787 mix Δ0.035 |
| 14314 | 4923471608 | t2 | river | QcJc | BTN | a | 0.5423 | 57% | 19.47 | 19.47 | — | 19.47 | 11% | 11% | — | 11% | ALLIN | ALLIN | — | ALLIN | 0.000 | 0.000 | — | 0.000 | 0.000 | 0.000 | — | 0.000 | 0.027 | DIFF · re-solved (players.0.range.weight: live 270.11 / walk 8.87) · mass Δ1.967 class Δ0.1664 mix Δ0.096 |
| 14494 | 4923481722 | t3 | flop | AhJc | UTG | a | 0.9710 | 97% | 234.33 | 234.33 | — | 234.33 | 4% | 4% | — | 4% | CHECK | CHECK | — | CHECK | 0.000 | 0.000 | — | 0.000 | 0.000 | 0.000 | — | 0.000 | 0.001 | ok · live tree · mass Δ0.000 class Δ0.0000 mix Δ0.000 |
| 14495 (chain) | 4923481722 | t3 | flop | AhJc | UTG | a | 0.9710 | 97% | 234.33 | 234.33 | — | 234.33 | 4% | 4% | — | 4% | CALL | CALL | — | CALL | 0.000 | 0.000 | — | 0.000 | 0.000 | 0.000 | — | 0.000 | 0.005 | ok · live tree · mass Δ0.000 class Δ0.0000 mix Δ0.000 |
| 14496 (chain) | 4923481722 | t3 | turn | AhJc | UTG | a | 0.9644 | 97% | 176.57 | 176.57 | — | 176.57 | 5% | 5% | — | 5% | CHECK | CHECK | — | CHECK | 0.000 | 0.000 | — | 0.000 | 0.000 | 0.000 | — | 0.000 | 0.000 | ok · live tree · mass Δ0.000 class Δ0.0001 mix Δ0.000 |
| 14497 (chain) | 4923481722 | t3 | turn | AhJc | UTG | a | 0.9644 | 97% | 176.57 | 176.57 | — | 176.57 | 5% | 5% | — | 5% | CALL | CALL | — | CALL | 0.000 | 0.000 | — | 0.000 | 0.000 | 0.000 | — | 0.000 | 0.008 | ok · live tree · mass Δ0.000 class Δ0.0001 mix Δ0.000 |
| 14498 (chain) | 4923481722 | t3 | river | AhJc | UTG | a | 0.9583 | 100% | 51.23 | 51.23 | — | 51.23 | 12% | 12% | — | 12% | CHECK | CHECK | — | CHECK | 0.000 | 0.000 | — | 0.000 | 0.000 | 0.000 | — | 0.000 | 0.004 | ok · live tree · mass Δ0.000 class Δ0.0001 mix Δ0.000 |
| 14613 (chain) | 4923488820 | t1 | flop | 6d6h | BB | a | 0.7941 | 79% | 302.58 | 302.58 | 302.58 | 302.58 | 2% | 2% | 2% | 2% | CHECK | CHECK | CHECK | CHECK | 0.000 | 0.000 | 0.000 | 0.000 | 0.000 | 0.000 | 0.000 | 0.000 | 0.001 | ok · live tree · mass Δ0.000 class Δ0.0000 mix Δ0.000 |
| 14615 (chain) | 4923488820 | t1 | turn | 6d6h | BB | a | 0.7114 | 71% | 262.53 | 262.53 | 262.53 | 262.53 | 2% | 2% | 2% | 2% | BET | BET | BET | BET | 0.000 | 0.000 | 0.000 | 0.000 | 0.000 | 0.000 | 0.000 | 0.000 | 0.002 | ok · live tree · mass Δ0.001 class Δ0.0000 mix Δ0.000 |
| 14617 | 4923488820 | t1 | river | 6d6h | BB | a | 0.0349 | 34% | 4.85 | 4.67 | 4.65 | 4.65 | 6% | 2% | 2% | 2% | BET | BET | BET | BET | -0.000 | -0.000 | 0.000 | 0.000 | -0.000 | 0.000 | 0.001 | 0.001 | 0.008 | ok · live tree · mass Δ0.001 class Δ0.0000 mix Δ0.000 |
| 14620 | 4923488820 | t1 | river | 6d6h | BB | a | 0.0349 | 34% | 4.85 | 4.67 | 4.65 | 4.65 | 6% | 2% | 2% | 2% | FOLD | FOLD | FOLD | FOLD | -0.004 | -0.002 | -0.002 | 0.000 | -0.002 | 0.000 | 0.001 | 0.003 | 0.023 | ok · live tree · mass Δ0.001 class Δ0.0000 mix Δ0.000 |
| 14631 (chain) | 4923489456 | t3 | flop | AsJs | BTN | a | 0.9986 | 100% | 544.30 | 544.30 | — | 544.30 | 1% | 1% | — | 1% | CHECK | CHECK | — | CHECK | 0.000 | 0.000 | — | 0.000 | 0.000 | 0.000 | — | 0.000 | 0.006 | ok · live tree · mass Δ0.000 class Δ0.0000 mix Δ0.000 |
| 14632 | 4923489456 | t3 | turn | AsJs | BTN | a | 0.4871 | 50% | 199.64 | 199.64 | — | 199.64 | 0% | 0% | — | 0% | CALL | CALL | — | CALL | 0.000 | 0.000 | — | 0.000 | 0.000 | 0.000 | — | 0.000 | 0.000 | ok · re-solved (bet_sizes.street_bet_sizes.1.position_bet_sizes.0.) · mass Δ0.001 class Δ0.0001 mix Δ0.000 |
| 14633 (chain) | 4923489456 | t3 | river | AsJs | BTN | a | 0.4866 | 54% | 109.21 | 109.21 | — | 109.21 | 1% | 1% | — | 1% | CHECK | CHECK | — | CHECK | 0.000 | 0.000 | — | 0.000 | 0.000 | 0.000 | — | 0.000 | 0.002 | ok · re-solved (bet_sizes.street_bet_sizes.1.position_bet_sizes.0.) · mass Δ0.694 class Δ0.0004 mix Δ0.003 |
| 14796 (chain) | 4923550810 | t3 | flop | 7dKd | SB | a | 0.8795 | 88% | 329.74 | 329.74 | — | 329.74 | 1% | 1% | — | 1% | CHECK | CHECK | — | CHECK | 0.000 | 0.000 | — | 0.000 | 0.000 | 0.000 | — | 0.000 | 0.001 | ok · live tree · mass Δ0.000 class Δ0.0000 mix Δ0.000 |
| 14799 (chain) | 4923550810 | t3 | turn | 7dKd | SB | a | 0.8771 | 88% | 307.79 | 307.79 | — | 307.79 | 1% | 1% | — | 1% | CHECK | CHECK | — | CHECK | 0.000 | 0.000 | — | 0.000 | 0.000 | 0.000 | — | 0.000 | 0.000 | ok · live tree · mass Δ0.002 class Δ0.0001 mix Δ0.000 |
| 14801 | 4923550810 | t3 | river | 7dKd | SB | a | 0.8767 | 88% | 288.70 | 288.70 | — | 288.70 | 1% | 1% | — | 1% | CHECK | CHECK | — | CHECK | 0.000 | 0.000 | — | 0.000 | 0.000 | 0.000 | — | 0.000 | 0.000 | ok · live tree · mass Δ0.001 class Δ0.0001 mix Δ0.000 |
| 14826 (chain) | 4923551624 | t1 | flop | ThTd | BB | a | 0.3464 | 91% | 16.87 | 16.87 | 16.87 | 16.87 | 12% | 12% | 12% | 12% | CHECK | CHECK | CHECK | CHECK | 0.000 | 0.000 | 0.000 | 0.000 | 0.000 | 0.000 | 0.000 | 0.000 | 0.001 | ok · live tree · mass Δ0.000 class Δ0.0000 mix Δ0.000 |
| 14827 | 4923551624 | t1 | flop | ThTd | BB | a | 0.3464 | 91% | 16.87 | 16.87 | 16.87 | 16.87 | 12% | 12% | 12% | 12% | CALL | CALL | CALL | CALL | 0.000 | 0.000 | 0.000 | 0.000 | 0.000 | 0.000 | 0.000 | 0.000 | 0.006 | ok · live tree · mass Δ0.000 class Δ0.0000 mix Δ0.212 |
| 14828 (chain) | 4923551624 | t1 | turn | ThTd | BB | a | 0.2849 | 87% | 11.09 | 11.09 | 11.09 | 11.09 | 16% | 16% | 16% | 16% | CHECK | CHECK | CHECK | CHECK | 0.000 | 0.000 | 0.000 | 0.000 | 0.000 | 0.000 | 0.000 | 0.000 | 0.008 | DIFF · re-solved (players.0.range.weight: live 10.63 / walk 11.45) · mass Δ0.800 class Δ0.0163 mix Δ0.576 pick live BET 12.4 / walk CHECK |
| 14829 | 4923551624 | t1 | river | ThTd | BB | a | 0.2313 | 71% | 8.88 | 8.88 | 8.88 | 8.88 | 17% | 17% | 17% | 17% | CHECK | CHECK | CHECK | CHECK | 0.000 | 0.000 | 0.000 | 0.000 | 0.000 | 0.000 | 0.000 | 0.000 | 0.001 | DIFF · re-solved (players.0.range.weight: live 10.63 / walk 11.45) · mass Δ6.249 class Δ1.0014 mix Δ0.000 |
| 14987 (chain) | 4923555748 | t2 | flop | TsTh | SB | a | 0.6361 | 79% | 30.57 | 30.57 | — | 30.57 | 12% | 12% | — | 12% | CHECK | CHECK | — | CHECK | 0.000 | 0.000 | — | 0.000 | 0.000 | 0.000 | — | 0.000 | 0.000 | ok · live tree · mass Δ0.000 class Δ0.0000 mix Δ0.000 |
| 14989 (chain) | 4923555748 | t2 | flop | TsTh | SB | a | 0.6361 | 79% | 30.57 | 30.57 | — | 30.57 | 12% | 12% | — | 12% | CALL | CALL | — | CALL | 0.000 | 0.000 | — | 0.000 | 0.000 | 0.000 | — | 0.000 | 0.003 | ok · live tree · mass Δ0.000 class Δ0.0000 mix Δ0.000 |
| 14990 (chain) | 4923555748 | t2 | turn | TsTh | SB | a | 0.5070 | 86% | 12.64 | 12.62 | — | 12.62 | 13% | 13% | — | 13% | CHECK | CHECK | — | CHECK | 0.000 | 0.000 | — | 0.000 | 0.000 | 0.000 | — | 0.000 | 0.001 | ok · live tree · mass Δ0.001 class Δ0.0000 mix Δ0.000 |
| 14991 | 4923555748 | t2 | turn | TsTh | SB | a | 0.5070 | 86% | 12.64 | 12.62 | — | 12.62 | 13% | 13% | — | 13% | CALL | CALL | — | CALL | 0.000 | 0.000 | — | 0.000 | 0.000 | 0.000 | — | 0.000 | 0.000 | DIFF · live tree · mass Δ0.001 class Δ0.0000 mix Δ0.951 pick live FOLD / walk CALL |
| 15063 (chain) | 4923557262 | t1 | flop | KdQh | BTN | a | 0.9979 | 100% | 318.64 | 318.64 | 318.64 | 318.64 | 4% | 4% | 4% | 4% | CHECK | CHECK | CHECK | CHECK | 0.000 | 0.000 | 0.000 | 0.000 | 0.000 | 0.000 | 0.000 | 0.000 | 0.005 | ok · live tree · mass Δ0.000 class Δ0.0000 mix Δ0.000 |
| 15064 (chain) | 4923557262 | t1 | turn | KdQh | BTN | a | 0.0126 | 31% | 5.64 | 5.27 | 5.27 | 5.27 | 11% | 4% | 4% | 4% | CHECK | CHECK | CHECK | CHECK | 0.021 | 0.000 | 0.000 | 0.000 | 0.021 | 0.000 | 0.000 | 0.000 | 0.018 | ok · live tree · mass Δ0.002 class Δ0.0000 mix Δ0.000 |
| 15066 | 4923557262 | t1 | river | KdQh | BTN | a | 0.0118 | 35% | 3.35 | 2.92 | 2.92 | 2.92 | 18% | 3% | 3% | 3% | BET | BET | BET | BET | 0.000 | 0.000 | 0.000 | 0.000 | 0.000 | 0.000 | 0.000 | 0.000 | 0.037 | ok · live tree · mass Δ0.003 class Δ0.0000 mix Δ0.000 |
| 15079 (chain) | 4923557528 | t1 | flop | JsAs | HJ | a | 0.9473 | 98% | 41.10 | 41.10 | 41.10 | 41.10 | 7% | 7% | 7% | 7% | CALL | CALL | CALL | CALL | 0.000 | 0.000 | 0.000 | 0.000 | 0.000 | 0.000 | 0.000 | 0.000 | 0.005 | ok · live tree · mass Δ0.000 class Δ0.0000 mix Δ0.090 |
| 15080 (chain) | 4923557528 | t1 | turn | JsAs | HJ | a | 0.8293 | 100% | 11.71 | 11.71 | 11.71 | 11.71 | 19% | 19% | 19% | 19% | CHECK | CHECK | CHECK | CHECK | 0.000 | 0.000 | 0.000 | 0.000 | 0.000 | 0.000 | 0.000 | 0.000 | 0.008 | DIFF · re-solved (players.0.range.weight: live 99.32 / walk 0.17) · mass Δ4.250 class Δ0.3546 mix Δ0.163 |
| 15082 | 4923557528 | t1 | river | JsAs | HJ | a | 0.0865 | 100% | 0.86 | 0.84 | 0.84 | 0.84 | 26% | 24% | 24% | 24% | CHECK | CHECK | CHECK | CHECK | -0.001 | 0.000 | 0.000 | 0.000 | -0.001 | 0.000 | 0.000 | 0.000 | 0.003 | DIFF · re-solved (players.0.range.weight: live 99.32 / walk 0.17) · mass Δ0.347 class Δ0.0061 mix Δ0.000 |
| 15233 (chain) | 4923560799 | t1 | flop | JhJd | SB | a | 0.6051 | 68% | 27.79 | 27.79 | 27.79 | 27.79 | 13% | 13% | 13% | 13% | CHECK | CHECK | CHECK | CHECK | 0.000 | 0.000 | 0.000 | 0.000 | 0.000 | 0.000 | 0.000 | 0.000 | 0.002 | ok · live tree · mass Δ0.000 class Δ0.0000 mix Δ0.000 |
| 15234 (chain) | 4923560799 | t1 | flop | JhJd | SB | a | 0.6051 | 68% | 27.79 | 27.79 | 27.79 | 27.79 | 13% | 13% | 13% | 13% | CALL | CALL | CALL | CALL | 0.000 | 0.000 | 0.000 | 0.000 | 0.000 | 0.000 | 0.000 | 0.000 | 0.008 | ok · live tree · mass Δ0.000 class Δ0.0000 mix Δ0.000 |
| 15235 | 4923560799 | t1 | turn | JhJd | SB | a | 0.2243 | 86% | 4.46 | 4.46 | 4.46 | 4.46 | 26% | 26% | 26% | 26% | CHECK | CHECK | CHECK | CHECK | 0.000 | 0.000 | 0.000 | 0.000 | 0.000 | 0.000 | 0.000 | 0.000 | 0.003 | ok · live tree · mass Δ0.001 class Δ0.0000 mix Δ0.000 |
| 15238 | 4923560799 | t1 | river | JhJd | SB | a | 0.2242 | 86% | 4.46 | 4.46 | 4.46 | 4.46 | 26% | 26% | 26% | 26% | CHECK | CHECK | CHECK | CHECK | 0.000 | 0.000 | 0.000 | 0.000 | 0.000 | 0.000 | 0.000 | 0.000 | 0.001 | ok · live tree · mass Δ0.001 class Δ0.0000 mix Δ0.000 |
| 15249 (chain) | 4923561023 | t2 | flop | AdJd | SB | a | 0.9983 | 100% | 161.52 | 161.52 | — | 161.52 | 2% | 2% | — | 2% | BET | BET | — | BET | 0.000 | 0.000 | — | 0.000 | 0.000 | 0.000 | — | 0.000 | 0.008 | ok · live tree · mass Δ0.000 class Δ0.0000 mix Δ0.000 |
| 15252 (chain) | 4923561023 | t2 | turn | AdJd | SB | a | 0.2157 | 36% | 26.27 | 26.27 | — | 26.27 | 3% | 3% | — | 3% | CHECK | CHECK | — | CHECK | 0.000 | 0.000 | — | 0.000 | 0.000 | 0.000 | — | 0.000 | 0.007 | ok · live tree · mass Δ0.005 class Δ0.0001 mix Δ0.000 |
| 15253 | 4923561023 | t2 | river | AdJd | SB | a | 0.1980 | 89% | 8.77 | 8.77 | — | 8.77 | 7% | 7% | — | 7% | CHECK | CHECK | — | CHECK | 0.000 | 0.000 | — | 0.000 | 0.000 | 0.000 | — | 0.000 | 0.000 | ok · live tree · mass Δ0.003 class Δ0.0001 mix Δ0.000 |
| 15255 (chain) | 4923561023 | t2 | river | AdJd | SB | a | 0.1980 | 89% | 8.77 | 8.77 | — | 8.77 | 7% | 7% | — | 7% | FOLD | FOLD | — | FOLD | 0.000 | 0.000 | — | 0.000 | 0.000 | 0.000 | — | 0.000 | 0.011 | ok · live tree · mass Δ0.003 class Δ0.0001 mix Δ0.000 |
| 15339 (chain) | 4923563108 | t2 | flop | 5s5h | SB | a | 0.2121 | 26% | 26.82 | 26.82 | — | 26.82 | 5% | 5% | — | 5% | CHECK | CHECK | — | CHECK | 0.000 | 0.000 | — | 0.000 | 0.000 | 0.000 | — | 0.000 | 0.000 | ok · live tree · mass Δ0.000 class Δ0.0000 mix Δ0.000 |
| 15340 | 4923563108 | t2 | turn | 5s5h | SB | a | 0.2117 | 30% | 17.01 | 16.99 | — | 16.99 | 5% | 5% | — | 5% | CHECK | CHECK | — | CHECK | -0.001 | -0.001 | — | 0.000 | 0.000 | 0.000 | — | 0.001 | 0.001 | ok · live tree · mass Δ0.001 class Δ0.0000 mix Δ0.000 |
| 15341 (chain) | 4923563108 | t2 | turn | 5s5h | SB | a | 0.2117 | 30% | 17.01 | 16.99 | — | 16.99 | 5% | 5% | — | 5% | FOLD | FOLD | — | FOLD | 0.000 | 0.000 | — | 0.000 | -0.000 | 0.000 | — | -0.000 | 0.000 | ok · live tree · mass Δ0.001 class Δ0.0000 mix Δ0.000 |
| 15373 (chain) | 4923563870 | t3 | flop | Ah4h | CO | a | 1.0000 | 100% | 295.85 | 295.85 | — | 295.85 | 1% | 1% | — | 1% | CALL | CALL | — | CALL | 0.000 | 0.000 | — | 0.000 | 0.000 | 0.000 | — | 0.000 | 0.000 | ok · live tree · mass Δ0.000 class Δ0.0000 mix Δ0.001 |
| 15374 | 4923563870 | t3 | turn | Ah4h | CO | a | 0.9950 | 100% | 216.83 | 216.83 | — | 216.83 | 1% | 1% | — | 1% | CALL | CALL | — | CALL | 0.000 | 0.000 | — | 0.000 | 0.000 | 0.000 | — | 0.000 | 0.048 | DIFF · re-solved (bet_sizes.street_bet_sizes.1.position_bet_sizes.0.) · mass Δ56.361 class Δ0.3883 mix Δ0.191 |
| 15384 | 4923564097 | t1 | flop | 8c8d | CO | a | 0.0145 | 19% | 1.39 | 1.18 | 1.18 | 1.18 | 22% | 7% | 7% | 7% | BET | ALLIN * | ALLIN * | ALLIN * | 0.036 | 0.000 | 0.000 | 0.000 | 0.036 | 0.000 | 0.000 | 0.000 | 0.027 | ok · live tree · mass Δ0.000 class Δ0.0000 mix Δ0.000 |
| 15431 (chain) | 4923565248 | t3 | flop | QcQd | BTN | a | 1.0000 | 100% | 479.42 | 479.42 | — | 479.42 | 1% | 1% | — | 1% | CHECK | CHECK | — | CHECK | 0.000 | 0.000 | — | 0.000 | 0.000 | 0.000 | — | 0.000 | 0.013 | ok · live tree · mass Δ0.000 class Δ0.0000 mix Δ0.000 |
| 15432 | 4923565248 | t3 | turn | QcQd | BTN | a | 0.3667 | 37% | 126.97 | 126.97 | — | 126.97 | 3% | 3% | — | 3% | BET | BET | — | BET | 0.000 | 0.000 | — | 0.000 | 0.000 | 0.000 | — | 0.000 | 0.010 | ok · live tree · mass Δ0.001 class Δ0.0000 mix Δ0.000 |
| 15439 (chain) | 4923565431 | t3 | flop | 4cJh | BB | a | 1.0000 | 100% | 1078.86 | 1078.86 | — | 1078.86 | 1% | 1% | — | 1% | CHECK | CHECK | — | CHECK | 0.000 | 0.000 | — | 0.000 | 0.000 | 0.000 | — | 0.000 | 0.000 | ok · live tree · mass Δ0.000 class Δ0.0000 mix Δ0.000 |
| 15441 | 4923565431 | t3 | flop | 4cJh | BB | a | 1.0000 | 100% | 1078.86 | 1078.86 | — | 1078.86 | 1% | 1% | — | 1% | CALL | CALL | — | CALL | -0.002 | 0.000 | — | 0.000 | -0.002 | 0.000 | — | 0.000 | 0.005 | ok · live tree · mass Δ0.000 class Δ0.0000 mix Δ0.000 |
| 15442 (chain) | 4923565431 | t3 | turn | 4cJh | BB | a | 0.9444 | 95% | 130.64 | 139.04 | — | 139.04 | 7% | 5% | — | 5% | CHECK | CHECK | — | CHECK | -0.000 | 0.000 | — | 0.000 | -0.000 | 0.000 | — | 0.000 | 0.000 | ok · re-solved (players.1.range.weight: live 211.87 / walk 57.19) · mass Δ0.007 class Δ0.0000 mix Δ0.001 |
| 15444 (chain) | 4923565431 | t3 | turn | 4cJh | BB | a | 0.9444 | 95% | 130.64 | 139.04 | — | 139.04 | 7% | 5% | — | 5% | FOLD | CALL * | — | CALL * | -0.001 | 0.000 | — | 0.000 | -0.001 | 0.000 | — | 0.000 | 0.018 | DIFF · re-solved (players.1.range.weight: live 211.87 / walk 57.19) · mass Δ0.007 class Δ0.0000 mix Δ0.713 pick live CALL 3 / walk FOLD |
| 15445 (chain) | 4923565431 | t3 | river | 4cJh | BB | a | 0.5699 | 62% | 53.74 | 65.37 | — | 65.37 | 7% | 6% | — | 6% | CHECK | CHECK | — | CHECK | -0.000 | 0.000 | — | 0.000 | -0.000 | 0.000 | — | 0.000 | 0.001 | DIFF · re-solved (players.1.range.weight: live 211.87 / walk 57.19) · mass Δ59.339 class Δ5.4099 mix Δ0.000 |
| 15447 (chain) | 4923565431 | t3 | river | 4cJh | BB | a | 0.5699 | 62% | 53.74 | 65.37 | — | 65.37 | 7% | 6% | — | 6% | CALL | CALL | — | CALL | -0.001 | 0.000 | — | 0.000 | -0.001 | 0.000 | — | 0.000 | 0.001 | DIFF · re-solved (players.1.range.weight: live 211.87 / walk 57.19) · mass Δ59.339 class Δ5.4099 mix Δ0.011 |
| 15500 (chain) | 4923566696 | t2 | flop | KdAh | CO | a | 0.4595 | 48% | 47.65 | 47.65 | — | 47.65 | 12% | 12% | — | 12% | BET | BET | — | BET | 0.000 | 0.000 | — | 0.000 | 0.000 | 0.000 | — | 0.000 | 0.004 | ok · live tree · mass Δ0.000 class Δ0.0000 mix Δ0.000 |
| 15501 | 4923566696 | t2 | turn | KdAh | CO | a | 0.1829 | 30% | 15.32 | 15.32 | — | 15.32 | 16% | 16% | — | 16% | FOLD | FOLD | — | FOLD | 0.000 | 0.000 | — | 0.000 | 0.000 | 0.000 | — | 0.000 | 0.005 | ok · live tree · mass Δ0.001 class Δ0.0001 mix Δ0.000 |
| 15564 (chain) | 4923567933 | t2 | flop | 7h7s | UTG | a | 1.0000 | 100% | 193.42 | 193.42 | — | 193.42 | 3% | 3% | — | 3% | BET | BET | — | BET | 0.000 | 0.000 | — | 0.000 | 0.000 | 0.000 | — | 0.000 | 0.006 | ok · live tree · mass Δ0.000 class Δ0.0000 mix Δ0.000 |
| 15566 (chain) | 4923567933 | t2 | turn | 7h7s | UTG | a | 0.2256 | 23% | 35.02 | 35.02 | — | 35.02 | 4% | 4% | — | 4% | BET | BET | — | BET | 0.000 | 0.000 | — | 0.000 | 0.000 | 0.000 | — | 0.000 | 0.003 | ok · live tree · mass Δ0.002 class Δ0.0001 mix Δ0.000 |
| 15567 | 4923567933 | t2 | river | 7h7s | UTG | a | 0.2044 | 30% | 15.93 | 15.92 | — | 15.89 | 6% | 6% | — | 6% | ALLIN | ALLIN | — | ALLIN | -0.000 | 0.000 | — | 0.000 | -0.000 | 0.000 | — | -0.000 | 0.002 | ok · live tree · mass Δ0.001 class Δ0.0001 mix Δ0.000 |
| 15606 (chain) | 4923568919 | t1 | flop | QhKh | UTG | a | 1.0000 | 100% | 206.71 | 206.71 | 206.71 | 206.71 | 1% | 1% | 1% | 1% | CHECK | CHECK | CHECK | CHECK | 0.000 | 0.000 | 0.000 | 0.000 | 0.000 | 0.000 | 0.000 | 0.000 | 0.004 | ok · live tree · mass Δ0.000 class Δ0.0000 mix Δ0.000 |
| 15608 | 4923568919 | t1 | turn | QhKh | UTG | a | 0.0343 | 56% | 4.75 | 4.72 | 4.72 | 4.72 | 3% | 3% | 3% | 3% | BET | BET | BET | BET | -0.001 | 0.000 | 0.000 | 0.000 | -0.001 | 0.000 | 0.000 | 0.000 | 0.007 | ok · live tree · mass Δ0.000 class Δ0.0000 mix Δ0.000 |
| 15895 (chain) | 4923624173 | t1 | flop | 7dAd | UTG | a | 0.9950 | 100% | 205.83 | 205.83 | 205.83 | 205.83 | 1% | 1% | 1% | 1% | CHECK | CHECK | CHECK | CHECK | 0.000 | 0.000 | 0.000 | 0.000 | 0.000 | 0.000 | 0.000 | 0.000 | 0.001 | ok · live tree · mass Δ0.000 class Δ0.0000 mix Δ0.000 |
| 15896 (chain) | 4923624173 | t1 | turn | 7dAd | UTG | a | 0.0363 | 10% | 26.93 | 26.92 | 26.92 | 26.92 | 1% | 1% | 1% | 1% | CHECK | CHECK | CHECK | CHECK | -0.000 | 0.000 | 0.000 | 0.000 | -0.000 | 0.000 | 0.000 | 0.000 | 0.001 | ok · live tree · mass Δ0.000 class Δ0.0001 mix Δ0.000 |
| 15898 (chain) | 4923624173 | t1 | turn | 7dAd | UTG | a | 0.0363 | 10% | 26.93 | 26.92 | 26.92 | 26.92 | 1% | 1% | 1% | 1% | CALL | CALL | CALL | CALL | -0.001 | 0.000 | 0.000 | 0.000 | -0.001 | 0.000 | 0.000 | 0.000 | 0.002 | ok · live tree · mass Δ0.000 class Δ0.0001 mix Δ0.000 |
| 15899 | 4923624173 | t1 | river | 7dAd | UTG | a | 0.0355 | 36% | 1.30 | 1.37 | 1.37 | 1.37 | 12% | 10% | 10% | 10% | CHECK | CHECK | CHECK | CHECK | 0.006 | 0.000 | 0.000 | 0.000 | 0.006 | 0.000 | 0.000 | 0.000 | 0.011 | ok · live tree · mass Δ0.000 class Δ0.0000 mix Δ0.000 |
| 15913 (chain) | 4923624699 | t1 | flop | AsAh | HJ | a | 0.4882 | 57% | 21.40 | 21.40 | 21.40 | 21.40 | 7% | 7% | 7% | 7% | CHECK | CHECK | CHECK | CHECK | 0.000 | 0.000 | 0.000 | 0.000 | 0.000 | 0.000 | 0.000 | 0.000 | 0.147 | ok · live tree · mass Δ0.000 class Δ0.0000 mix Δ0.000 |
| 15914 (chain) | 4923624699 | t1 | turn | AsAh | HJ | a | 0.2746 | 53% | 9.67 | 9.67 | 9.67 | 9.67 | 9% | 9% | 9% | 9% | BET | BET | BET | BET | 0.000 | 0.000 | 0.000 | 0.000 | 0.000 | 0.000 | 0.000 | 0.000 | 0.030 | ok · live tree · mass Δ0.000 class Δ0.0000 mix Δ0.000 |
| 15916 | 4923624699 | t1 | river | AsAh | HJ | a | 0.2512 | 82% | 3.37 | 3.37 | 3.37 | 3.37 | 24% | 24% | 24% | 24% | BET | BET | BET | BET | 0.000 | 0.000 | 0.000 | 0.000 | 0.000 | 0.000 | 0.000 | 0.000 | 0.040 | ok · live tree · mass Δ0.002 class Δ0.0000 mix Δ0.000 |
| 15920 (chain) | 4923624883 | t1 | flop | Ac8c | HJ | a | 1.0000 | 100% | 210.94 | 210.94 | 210.94 | 210.94 | 1% | 1% | 1% | 1% | BET | BET | BET | BET | 0.000 | 0.000 | 0.000 | 0.000 | 0.000 | 0.000 | 0.000 | 0.000 | 0.014 | ok · live tree · mass Δ0.000 class Δ0.0000 mix Δ0.000 |
| 15921 (chain) | 4923624883 | t1 | turn | Ac8c | HJ | a | 0.1326 | 57% | 20.41 | 20.41 | 20.41 | 20.41 | 1% | 1% | 1% | 1% | CHECK | CHECK | CHECK | CHECK | 0.000 | 0.000 | 0.000 | 0.000 | 0.000 | 0.000 | 0.000 | 0.000 | 0.003 | ok · live tree · mass Δ0.000 class Δ0.0000 mix Δ0.000 |
| 15922 | 4923624883 | t1 | river | Ac8c | HJ | a | 0.0032 | 11% | 0.63 | 0.54 | 0.54 | 0.54 | 16% | 1% | 1% | 1% | CHECK | CHECK | CHECK | CHECK | -0.000 | 0.000 | 0.000 | 0.000 | -0.000 | 0.000 | 0.000 | 0.000 | 0.001 | ok · live tree · mass Δ0.000 class Δ0.0000 mix Δ0.000 |
| 16194 (chain) | 4924194459 | t2 | flop | 8hKd | BTN | a | 0.7426 | 74% | 498.57 | 498.57 | — | 498.57 | 2% | 2% | — | 2% | BET | BET | — | BET | 0.000 | 0.000 | — | 0.000 | 0.000 | 0.000 | — | 0.000 | 0.008 | ok · live tree · mass Δ0.000 class Δ0.0000 mix Δ0.000 |
| 16196 (chain) | 4924194459 | t2 | turn | 8hKd | BTN | a | 0.1705 | 36% | 61.09 | 61.02 | — | 60.97 | 2% | 2% | — | 2% | BET | BET | — | BET | 0.001 | 0.001 | — | 0.000 | -0.001 | 0.000 | — | -0.001 | 0.008 | ok · live tree · mass Δ0.005 class Δ0.0001 mix Δ0.000 |
| 16198 | 4924194459 | t2 | river | 8hKd | BTN | a | 0.0860 | 48% | 8.40 | 8.01 | — | 7.89 | 9% | 6% | — | 5% | CHECK | CHECK | — | CHECK | -0.000 | -0.000 | — | 0.000 | 0.000 | 0.000 | — | 0.000 | 0.004 | ok · live tree · mass Δ0.002 class Δ0.0001 mix Δ0.000 |
| 16237 | 4924195300 | t1 | flop | 9cKc | BTN | a | 0.0005 | 8% | 0.99 | 0.85 | 0.85 | 0.85 | 15% | 0% | 0% | 0% | BET | BET | BET | BET | 0.010 | 0.000 | 0.000 | 0.000 | 0.010 | 0.000 | 0.000 | 0.000 | 0.008 | ok · live tree · mass Δ0.000 class Δ0.0000 mix Δ0.000 |
| 16240 | 4924195300 | t1 | turn | 9cKc | BTN | a | 0.0004 | 7% | 0.81 | 0.67 | 0.67 | 0.67 | 18% | 0% | 0% | 0% | CALL | CALL | CALL | CALL | -0.000 | 0.000 | 0.000 | 0.000 | -0.000 | 0.000 | 0.000 | 0.000 | 0.000 | ok · live tree · mass Δ0.001 class Δ0.0000 mix Δ0.002 |
| 16241 | 4924195300 | t1 | river | 9cKc | BTN | a | 0.0004 | 10% | 0.58 | 0.41 | 0.41 | 0.41 | 26% | 0% | 0% | 0% | CHECK | BET * | BET * | BET * | 0.002 | 0.000 | 0.000 | 0.000 | 0.002 | 0.000 | 0.000 | 0.000 | 0.022 | ok · re-solved (players.0.range.weight: live 20.73 / walk 0.45) · mass Δ0.003 class Δ0.0000 mix Δ0.034 |
| 16400 | 4924199127 | t3 | flop | Jh7s | BB | a | 0.9238 | 92% | 836.93 | 836.93 | — | 836.93 | 1% | 1% | — | 1% | BET | BET | — | BET | 0.000 | 0.000 | — | 0.000 | 0.000 | 0.000 | — | 0.000 | 0.002 | ok · live tree · mass Δ0.000 class Δ0.0000 mix Δ0.000 |
| 16401 (chain) | 4924199127 | t3 | flop | Jh7s | BB | a | 0.9238 | 92% | 836.93 | 836.93 | — | 836.93 | 1% | 1% | — | 1% | RAISE | RAISE | — | RAISE | 0.000 | 0.000 | — | 0.000 | 0.000 | 0.000 | — | 0.000 | 0.007 | ok · live tree · mass Δ0.000 class Δ0.0000 mix Δ0.000 |
| 16402 (chain) | 4924199127 | t3 | turn | Jh7s | BB | a | 0.0260 | 3% | 99.75 | 99.74 | — | 99.43 | 1% | 1% | — | 1% | CHECK | CHECK | — | CHECK | -0.000 | 0.001 | — | 0.000 | -0.001 | 0.000 | — | -0.000 | 0.001 | ok · live tree · mass Δ0.002 class Δ0.0001 mix Δ0.000 |
| 16403 (chain) | 4924199127 | t3 | river | Jh7s | BB | a | 0.0246 | 3% | 94.80 | 94.89 | — | 94.23 | 1% | 1% | — | 1% | CHECK | CHECK | — | CHECK | -0.004 | -0.003 | — | 0.000 | -0.001 | 0.000 | — | 0.004 | 0.007 | ok · live tree · mass Δ0.000 class Δ0.0001 mix Δ0.000 |
| 16405 (chain) | 4924199127 | t3 | river | Jh7s | BB | a | 0.0246 | 3% | 94.80 | 94.89 | — | 94.23 | 1% | 1% | — | 1% | FOLD | FOLD | — | RAISE * | 0.150 | 0.150 | — | 0.000 | 0.000 | 0.000 | — | 0.142 | 0.137 | ok · live tree · mass Δ0.000 class Δ0.0001 mix Δ0.000 |
| 16413 (chain) | 4924199364 | t2 | flop | QhJd | CO | a | 0.0063 | 1% | 152.50 | 152.50 | — | 151.98 | 0% | 0% | — | 0% | BET | BET | — | BET | -0.002 | -0.002 | — | 0.000 | 0.000 | 0.000 | — | 0.001 | 0.003 | ok · live tree · mass Δ0.000 class Δ0.0000 mix Δ0.000 |
| 16415 (chain) | 4924199364 | t2 | turn | QhJd | CO | a | 0.0018 | 0% | 52.58 | 52.29 | — | 56.00 | 1% | 1% | — | 0% | BET | BET | — | BET | 0.001 | 0.001 | — | 0.000 | -0.000 | 0.000 | — | -0.002 | 0.008 | ok · live tree · mass Δ0.011 class Δ0.0000 mix Δ0.000 |
| 16417 | 4924199364 | t2 | river | QhJd | CO | a | 0.0002 | 0% | 12.64 | 12.08 | — | 12.64 | 5% | 2% | — | 0% | FOLD | FOLD | — | FOLD | -0.000 | 0.003 | — | 0.000 | -0.003 | 0.000 | — | -0.003 | 0.000 | ok · live tree · mass Δ0.003 class Δ0.0000 mix Δ0.002 |
| 16429 | 4924199688 | t1 | flop | QdQs | SB | a | 0.0394 | 26% | 4.34 | 4.27 | 4.27 | 4.27 | 7% | 6% | 6% | 6% | BET | BET | BET | BET | 0.004 | 0.000 | 0.000 | 0.000 | 0.004 | 0.000 | 0.000 | 0.000 | 0.014 | ok · live tree · mass Δ0.000 class Δ0.0000 mix Δ0.000 |
| 16431 | 4924199688 | t1 | turn | QdQs | SB | a | 0.0258 | 23% | 2.76 | 2.80 | 2.80 | 2.80 | 11% | 6% | 6% | 6% | BET | BET | BET | BET | 0.002 | 0.000 | 0.000 | 0.000 | 0.002 | 0.000 | 0.000 | 0.000 | 0.020 | ok · live tree · mass Δ0.000 class Δ0.0000 mix Δ0.000 |
| 16432 | 4924199688 | t1 | river | QdQs | SB | a | 0.0248 | 34% | 1.48 | 1.35 | 1.35 | 1.35 | 20% | 10% | 10% | 10% | ALLIN | ALLIN | ALLIN | ALLIN | -0.000 | 0.000 | 0.000 | 0.000 | -0.000 | 0.000 | 0.000 | 0.000 | 0.002 | ok · live tree · mass Δ0.001 class Δ0.0000 mix Δ0.000 |
| 16597 | 4924400364 | t3 | flop | Qs9s | HJ | a | 0.9960 | 100% | 233.37 | 233.37 | — | 233.37 | 1% | 1% | — | 1% | CHECK | CHECK | — | CHECK | 0.000 | 0.000 | — | 0.000 | 0.000 | 0.000 | — | 0.000 | 0.000 | ok · live tree · mass Δ0.000 class Δ0.0000 mix Δ0.000 |
| 16599 (chain) | 4924400364 | t3 | turn | Qs9s | HJ | a | 0.9955 | 100% | 165.47 | 165.47 | — | 165.47 | 2% | 2% | — | 2% | BET | BET | — | BET | 0.000 | 0.000 | — | 0.000 | 0.000 | 0.000 | — | 0.000 | 0.003 | ok · live tree · mass Δ0.000 class Δ0.0001 mix Δ0.000 |
| 16600 (chain) | 4924400364 | t3 | turn | Qs9s | HJ | a | 0.9955 | 100% | 165.47 | 165.47 | — | 165.47 | 2% | 2% | — | 2% | FOLD | FOLD | — | FOLD | 0.000 | 0.000 | — | 0.000 | 0.000 | 0.000 | — | 0.000 | 0.003 | ok · live tree · mass Δ0.000 class Δ0.0001 mix Δ0.000 |
| 16614 | 4924400878 | t3 | flop | KdKc | UTG | a | 1.0000 | 100% | 221.65 | 221.65 | — | 221.65 | 3% | 3% | — | 3% | BET | BET | — | BET | 0.000 | 0.000 | — | 0.000 | 0.000 | 0.000 | — | 0.000 | 0.054 | ok · live tree · mass Δ0.000 class Δ0.0000 mix Δ0.000 |
| 16645 (chain) | 4924401843 | t1 | flop | TcAs | BB | a | 0.3259 | 39% | 57.96 | 57.96 | 57.96 | 57.96 | 7% | 7% | 7% | 7% | BET | BET | BET | BET | 0.000 | 0.000 | 0.000 | 0.000 | 0.000 | 0.000 | 0.000 | 0.000 | 0.020 | ok · live tree · mass Δ0.000 class Δ0.0000 mix Δ0.000 |
| 16646 | 4924401843 | t1 | turn | TcAs | BB | a | 0.0049 | 52% | 0.64 | 0.24 | 0.24 | 0.24 | 70% | 20% | 20% | 20% | ALLIN | BET * | BET * | BET * | 0.664 | 0.000 | 0.000 | 0.000 | 0.664 | 0.000 | 0.000 | 0.000 | 0.099 | ok · live tree · mass Δ0.002 class Δ0.0000 mix Δ0.000 |
| 16789 (chain) | 4924405787 | t1 | flop | Ah2h | CO | a | 0.3982 | 76% | 74.58 | 74.58 | 74.58 | 74.58 | 2% | 2% | 2% | 2% | BET | BET | BET | BET | 0.000 | 0.000 | 0.000 | 0.000 | 0.000 | 0.000 | 0.000 | 0.000 | 0.006 | ok · live tree · mass Δ0.000 class Δ0.0000 mix Δ0.000 |
| 16790 | 4924405787 | t1 | turn | Ah2h | CO | a | 0.0543 | 100% | 1.63 | 1.60 | 1.60 | 1.60 | 10% | 8% | 8% | 8% | CHECK | CHECK | CHECK | CHECK | 0.000 | 0.000 | 0.000 | 0.000 | 0.000 | 0.000 | 0.000 | 0.000 | 0.008 | ok · live tree · mass Δ0.000 class Δ0.0001 mix Δ0.000 |
| 16791 | 4924405787 | t1 | river | Ah2h | CO | a | 0.0197 | 72% | 0.84 | 0.75 | 0.75 | 0.75 | 18% | 8% | 8% | 8% | CHECK | CHECK | CHECK | CHECK | 0.000 | 0.000 | 0.000 | 0.000 | 0.000 | 0.000 | 0.000 | 0.000 | 0.001 | ok · live tree · mass Δ0.000 class Δ0.0000 mix Δ0.000 |

## Where the choice matters most (tagged, by abs's excess loss under the natural reference)
- **10843** hand 4922269408 flop UTG AdQc, regime a, natural weight 0.0001; excess(abs | none) 2.677 bb (raw 2.678), excess(rel5 | none) 0.002 bb, loss(none | abs) 0.000 bb vs abs's own 0.009
  - abs: mass 3.16, class share 19% — FOLD 66.9% (EV 0.00), CALL 33.1% (EV 0.01), RAISE 0.0% (EV -8.18), RAISE 0.0% (EV -13.18), ALLIN 0.0% (EV -9.47)
  - rel5: mass 2.67, class share 4% — FOLD 0.1% (EV 0.00), CALL 99.9% (EV 2.11), RAISE 0.0% (EV -2.93), RAISE 0.0% (EV -5.47), ALLIN 0.0% (EV -2.99)
  - rel1: mass 2.58, class share 1% — FOLD 0.0% (EV 0.00), CALL 100.0% (EV 3.51), RAISE 0.0% (EV -2.88), RAISE 0.0% (EV -7.42), ALLIN 0.0% (EV -3.24)
  - none: mass 2.56, class share 0% — FOLD 0.0% (EV 0.00), CALL 100.0% (EV 4.00), RAISE 0.0% (EV -3.00), RAISE 0.0% (EV -7.28), ALLIN 0.0% (EV -3.50)
- **9654** hand 4921735323 river CO KhKs, regime a, natural weight 0.0135; excess(abs | none) 2.619 bb (raw 2.619), excess(rel5 | none) 0.000 bb, loss(none | abs) 0.060 bb vs abs's own 0.018
  - abs: mass 1.05, class share 29% — FOLD 71.0% (EV 0.00), CALL 29.0% (EV -0.06), ALLIN 0.1% (EV -0.74)
  - rel5: mass 0.67, class share 9% — FOLD 0.0% (EV 0.00), CALL 100.0% (EV 3.69), ALLIN 0.0% (EV 2.58)
  - rel1: mass 0.67, class share 9% — FOLD 0.0% (EV 0.00), CALL 100.0% (EV 3.69), ALLIN 0.0% (EV 2.58)
  - none: mass 0.67, class share 9% — FOLD 0.0% (EV 0.00), CALL 100.0% (EV 3.69), ALLIN 0.0% (EV 2.58)
- **16646** hand 4924401843 turn BB TcAs, regime a, natural weight 0.0049; excess(abs | none) 0.664 bb (raw 0.679), excess(rel5 | none) 0.000 bb, loss(none | abs) 0.099 bb vs abs's own 0.010
  - abs: mass 0.64, class share 70% — CHECK 0.0% (EV 15.20), BET 1.0% (EV 15.61), BET 1.4% (EV 15.68), BET 1.0% (EV 15.63), BET 0.1% (EV 15.51), BET 10.9% (EV 15.68), BET 2.0% (EV 15.54), ALLIN 83.5% (EV 15.71)
  - rel5: mass 0.24, class share 20% — CHECK 9.0% (EV 17.21), BET 3.4% (EV 17.13), BET 45.8% (EV 17.22), BET 41.0% (EV 17.24), BET 0.7% (EV 17.06), BET 0.0% (EV 17.09), BET 0.0% (EV 16.41), ALLIN 0.0% (EV 16.46)
  - rel1: mass 0.24, class share 20% — CHECK 9.0% (EV 17.21), BET 3.4% (EV 17.13), BET 45.8% (EV 17.22), BET 41.0% (EV 17.24), BET 0.7% (EV 17.06), BET 0.0% (EV 17.09), BET 0.0% (EV 16.41), ALLIN 0.0% (EV 16.46)
  - none: mass 0.24, class share 20% — CHECK 9.0% (EV 17.21), BET 3.4% (EV 17.13), BET 45.8% (EV 17.22), BET 41.0% (EV 17.24), BET 0.7% (EV 17.06), BET 0.0% (EV 17.09), BET 0.0% (EV 16.41), ALLIN 0.0% (EV 16.46)
- **11380** hand 4922298483 turn SB 2d2h, regime a, natural weight 0.0273; excess(abs | none) 0.125 bb (raw 0.216), excess(rel5 | none) 0.000 bb, loss(none | abs) 0.959 bb vs abs's own 0.152
  - abs: mass 0.81, class share 18% — FOLD 0.0% (EV 0.00), CALL 2.5% (EV 26.24), RAISE 18.4% (EV 29.50), ALLIN 79.1% (EV 29.84)
  - rel5: mass 0.74, class share 11% — FOLD 0.0% (EV 0.00), CALL 26.3% (EV 31.73), RAISE 3.0% (EV 30.81), ALLIN 70.7% (EV 31.95)
  - rel1: mass 0.74, class share 11% — FOLD 0.0% (EV 0.00), CALL 26.3% (EV 31.73), RAISE 3.0% (EV 30.81), ALLIN 70.7% (EV 31.95)
  - none: mass 0.74, class share 11% — FOLD 0.0% (EV 0.00), CALL 26.3% (EV 31.73), RAISE 3.0% (EV 30.81), ALLIN 70.7% (EV 31.95)
- **12803** hand 4922375825 river BB QhAs, regime a, natural weight 0.0008; excess(abs | none) 0.096 bb (raw 0.118), excess(rel5 | none) -0.002 bb, loss(none | abs) 0.106 bb vs abs's own 0.028
  - abs: mass 1.40, class share 43% — CHECK 54.3% (EV -0.00), BET 2.7% (EV -0.05), BET 6.4% (EV -0.11), BET 20.9% (EV -0.03), BET 3.8% (EV -0.06), BET 1.7% (EV -0.19), BET 3.4% (EV -0.06), BET 5.1% (EV -0.08), ALLIN 1.7% (EV -0.06)
  - rel5: mass 0.38, class share 3% — CHECK 0.7% (EV -0.00), BET 35.5% (EV 0.14), BET 3.5% (EV 0.09), BET 2.2% (EV 0.03), BET 9.4% (EV 0.13), BET 36.3% (EV 0.16), BET 12.2% (EV 0.08), BET 0.1% (EV -0.08), ALLIN 0.0% (EV -0.32)
  - rel1: mass 0.38, class share 2% — CHECK 1.0% (EV -0.00), BET 31.6% (EV 0.14), BET 5.5% (EV 0.05), BET 0.5% (EV 0.05), BET 11.4% (EV 0.11), BET 36.5% (EV 0.13), BET 13.2% (EV 0.07), BET 0.3% (EV 0.01), ALLIN 0.0% (EV -0.32)
  - none: mass 0.38, class share 2% — CHECK 1.0% (EV -0.00), BET 31.6% (EV 0.14), BET 5.5% (EV 0.05), BET 0.5% (EV 0.05), BET 11.4% (EV 0.11), BET 36.5% (EV 0.13), BET 13.2% (EV 0.07), BET 0.3% (EV 0.01), ALLIN 0.0% (EV -0.32)