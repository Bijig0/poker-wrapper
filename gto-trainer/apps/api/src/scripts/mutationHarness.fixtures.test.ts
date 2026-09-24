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
