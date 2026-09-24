/**
 * THE INPUT-MUTATION GATE (2026-09-25, Brady: part of the regression run). A short, deterministic sweep of the
 * harness in src/scripts/mutationHarness.ts: 30 seeds × every operator, no pairs. Offline (GTOW_BLOCK=1, dry
 * postflop). Red means a real-table state the study tool cannot turn into a solver input; the summary names it.
 * The full sweep (hundreds of seeds, pairs) is the script itself.
 */
import { expect, test } from "bun:test";
import { sweep, summarize, OPERATORS } from "./mutationHarness";

// ITS OWN PROCESS (setup/regress.ts runs it with MUTATION_GATE=1): bun runs every test file in one process, and a
// sweep leaves the GTO Wizard session state changed (hundreds of blocked requests) — the poller test that follows
// it in the plain `bun test` run read that state and failed. Skipped there, run alone by the regression gate.
test.skipIf(process.env.MUTATION_GATE !== "1")("every mutated table state yields a solver input or a named, correct refusal (30 seeds × all operators)", async () => {
  const res = await sweep({ seeds: 30, seed0: 1, ops: [...OPERATORS], pairs: 0 });
  if (res.findings.length) console.log(summarize(res));
  expect(res.findings.map((f) => `${f.street} ${f.kind} seed ${f.seed} [${f.ops.join("+")}]: ${f.reason.slice(0, 120)}`)).toEqual([]);
}, 600_000);
