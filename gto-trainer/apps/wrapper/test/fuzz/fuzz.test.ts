/**
 * THE HAND FUZZER as a test (the Python regression gate's "line fuzz" tier, ported 2026-09-24): 600 dealt hands
 * per artefact combination — none, each artefact alone, all at once — and the line the reader derives must equal
 * the line that was played, every time. Seed for seed the same hands the Python fuzzer dealt (verified field by
 * field over 1,200 hands before the Python one was deleted: scripts, tick streams, played and read lines).
 */
import { expect, test } from "bun:test";
import { DEFAULT_COMBOS, runCombo } from "./fuzzReconcile";

test("the reader reconstructs every fuzzed hand exactly (600 per artefact combination)", () => {
  const bad: string[] = [];
  for (const combo of DEFAULT_COMBOS) {
    const r = runCombo(600, combo);
    if (r.bad) bad.push(`artefacts=${r.label}: ${r.bad}/${r.n - r.skipped} wrong\n${r.examples.join("\n")}`);
  }
  expect(bad).toEqual([]);
}, 300_000);
