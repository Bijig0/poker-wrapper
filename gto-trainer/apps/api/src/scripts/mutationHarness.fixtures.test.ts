/**
 * THE INPUT-MUTATION FIXTURES (2026-09-25, overnight fixer): one replayable case per finding class fixed that night,
 * run through the real pipeline against the baked charts. Each seed/ops pair is the harness's own reproduction of a
 * class (runCase seeds its rolls, so a case replays exactly); src/scripts/mutation/REPORT.md names the root cause and
 * the unit test of each. Gated like the sweep (MUTATION_GATE=1, its own process, HRC6MAX_DB at the bake): it needs
 * the chart database, which a worktree does not carry.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { harnessEnv, runCase, type Op } from "./mutationHarness";

const gated = process.env.MUTATION_GATE !== "1";
let restore: (() => void) | null = null;
beforeAll(() => { if (!gated) restore = harnessEnv(); });
afterAll(() => { restore?.(); });

const CASES: { seed: number; ops: Op[]; cls: string; refusals?: boolean }[] = [
  { seed: 2, ops: ["late-fold"], cls: "a preflop fold filed late, refused on the flop as out of rotation" },
  { seed: 17, ops: ["late-fold"], cls: "a preflop fold filed late, refused on every street" },
  { seed: 26, ops: ["dropped-call"], cls: "a lost call before a fold — only the pot shows it at the flop", refusals: true },
  { seed: 152, ops: ["dropped-call"], cls: "a lost call before a fold, preflop (committed)", refusals: true },
  { seed: 158, ops: ["dropped-call"], cls: "the SB's lost complete, then the SB checks the flop", refusals: true },
  { seed: 1, ops: ["limps"], cls: "generator: the BB's option in a limped pot" },
  { seed: 138, ops: ["limps"], cls: "generator: a 'Limp' pick executed as a call" },
  { seed: 111, ops: ["limps"], cls: "a fitted pin: the folded-out limper calls hero's squeeze" },
  { seed: 589, ops: ["limps"], cls: "the caller-cap borrow's fold kept for hero's later decision" },
  { seed: 93, ops: ["hero-deviates"], cls: "the pinned walk past the tree's caps after hero's decision" },
  { seed: 144, ops: ["hero-deviates"], cls: "hero off the pick: the AI tree answers (cloud-gated offline)" },
  { seed: 1231, ops: ["odd-open"], cls: "the chart changed under hero (equilibrium iso, pool-tree 3-bet)" },
  { seed: 1065, ops: ["deep-seat"], cls: "generator: an All-in pick is the whole stack" },
  { seed: 178, ops: ["short-seat"], cls: "harness: no pick after a cloud-gated decision" },
  { seed: 1865, ops: ["hero-deviates"], cls: "hero off the pick into an action the pinned chart lacks (SB complete in a raise tree)" },
  { seed: 2775, ops: ["nl5-rounding"], cls: "a second caller of a 4-bet: the seat read on the line as it stands, with the caller borrow" },
  { seed: 2593, ops: ["thin-table"], cls: "a fit folded the limper hero's earlier decision was read with" },
  { seed: 3992, ops: ["limps"], cls: "the same, where the tree holds the line with the limper kept" },
  { seed: 1333, ops: ["jam"], cls: "a short stack's jam called twice: a side pot, not an all-in flop" },
  { seed: 2053, ops: ["jam"], cls: "a 25bb jam snapped onto the chart's 2.5bb open — refused, the exact tree answers" },
  { seed: 3, ops: ["missed-fold"], cls: "a fold lost in a later orbit: written into its slot" },
  { seed: 12, ops: ["missed-fold"], cls: "a fold lost in the opening orbit: no capture fault on the flop" },
  { seed: 627, ops: ["missed-fold"], cls: "a padded opening-orbit fold is not written a second time" },
  // round 2 (the range-level oracle, scripts/mutation/rangeOracle.ts)
  { seed: 50, ops: ["jam"], cls: "range oracle: a 3-bet past τ conditioned the flop ranges on the chart's neighbour (size-past-tolerance)" },
  { seed: 5, ops: ["nl5-rounding"], cls: "range oracle: a 2.6 open read as 2.5 with no word of it (size-snap-unreported)" },
  { seed: 44, ops: [], cls: "range oracle: an 8.75 3-bet read as 9, unsaid (size-snap-unreported)" },
  { seed: 3, ops: ["stack-drift"], cls: "range oracle: a 25bb 4-bet read as the chart's 23, unsaid (size-snap-unreported)" },
  { seed: 1669, ops: ["short-seat"], cls: "range oracle: a fitted pin read by the pinned walk, the fit unsaid (range-mismatch)" },
  { seed: 1559, ops: ["odd-open"], cls: "range oracle: the same, hero UTG after the caller-cap borrow (range-mismatch)" },
  { seed: 1130, ops: ["thin-table"], cls: "range oracle: the same, a villain's range on the fitted line (range-mismatch)" },
  { seed: 2328, ops: ["jam"], cls: "range oracle: an all-in CALL for 25 read as the chart's jam to 30 (preflop-node-mismatch)" },
  { seed: 2807, ops: ["hero-deviates"], cls: "range oracle: hero's 92s at 1.6e-6 written as 0 in the tree's array (hero-combo-zero)" },
  { seed: 86, ops: [], cls: "an all-in CALL for less (C since the all-in-call fix) counted at the full price in the flop pot" },
  // Part C (zenbook-main's post-in / undealt-seat, the operators added in round 2)
  { seed: 1, ops: ["post-in"], cls: "post-in: the CO's pending post refused as a lost action (capture-fault)" },
  { seed: 2, ops: ["post-in"], cls: "post-in: hero posted in, his pending post refused as a lost action (capture-fault)" },
  { seed: 8, ops: ["post-in"], cls: "post-in: a folded poster's dead post missing from the flop pot (solver-input-mismatch)" },
  { seed: 1, ops: ["undealt-seat"], cls: "undealt-seat: three dealt + a sitting-out label answered from the 6-max charts (piece-routing)" },
  { seed: 5, ops: ["undealt-seat"], cls: "undealt-seat: the rake cap counted the sitting-out label (rake-cap)" },
  { seed: 2, ops: ["undealt-seat"], cls: "undealt-seat: a dead button (five dealt) sent to the AI piece as thinned (piece-routing, golden 4919260843)" },
  { seed: 412, ops: ["post-in", "missed-fold"], cls: "post-in + missed-fold: a poster whose fold was lost, still 'pending' at the flop — his dead post (solver-input-mismatch)" },
  { seed: 199, ops: ["unlabelled-seat", "post-in"], cls: "unlabelled-seat + post-in: a poster with no label answered (answered-corrupt-capture)", refusals: true },
  { seed: 232, ops: ["missed-fold"], cls: "missed-fold: hero's turn check dropped as a phantom — the lost-fold seat counted live (postflop-line-mismatch)" },
  { seed: 213, ops: ["missed-fold", "nl5-rounding"], cls: "the same on the flop (postflop-line-mismatch)" },
  { seed: 14999, ops: ["short-seat"], cls: "the chart changed under hero (the short BTN folded) and the kept chart pruned the 3-bet: no decision (hero-zero-weight)" },
  { seed: 85, ops: ["missed-fold"], cls: "stack behind: a lost-fold seat's stack set the effective depth (solver-input-mismatch)" },
  { seed: 15564, ops: ["missed-fold"], cls: "a BLIND's lost fold: his post counted as acting, hero's check dropped as a phantom (postflop-line-mismatch)" },
  { seed: 17644, ops: ["missed-fold"], cls: "the same, the SB's lost fold and the BB's flop check (postflop-line-mismatch)" },
  { seed: 21901, ops: ["jam"], cls: "a preflop all-in player counted in the flop rotation; the HJ's check dropped (postflop-line-mismatch)" },
  { seed: 27266, ops: ["missed-fold"], cls: "the depth read before the capture repair wrote a lost later-orbit fold (stack behind 91 vs 89.2)" },
  { seed: 22, ops: ["undealt-seat"], cls: "stack behind: a sitting-out label's stack set the effective depth (solver-input-mismatch)" },
  { seed: 18287, ops: ["short-seat"], cls: "the pinned chart cannot hold a fifth entrant after hero's squeeze; the flop re-picked a chart where hero never squeezes (hero-zero-weight)" },
];

describe("input-mutation fixtures (one per class fixed 2026-09-25)", () => {
  for (const c of CASES) {
    test.skipIf(gated)(`seed ${c.seed} [${c.ops.join("+")}] — ${c.cls}`, async () => {
      const r = await runCase(c.seed, c.ops);
      const bad = r.verdicts.filter((v) => v.verdict === "finding").map((v) => `${v.street} ${v.kind}: ${String(v.reason).slice(0, 160)}`);
      expect(bad).toEqual([]);
      if (c.refusals) expect(r.verdicts.some((v) => v.verdict === "expected-refusal")).toBe(true);
    }, 120_000);
  }
});
