/**
 * NO HEADS-UP LAST RESORT IN THE 6-MAX STRATEGY (2026-10-05, Brady: "remove it entirely"). A 6-max preflop line the
 * exact GTO Wizard tree does not answer gets no answer — it is never re-played heads-up against the last raise
 * (hand 4922577812: the heads-up answer landed 2.6 s after the 45 s ask gave up). The CoinPoker ring strategy keeps
 * its last resort. Read from the source: the branch runs only after the charts and a live cloud solve have both failed.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const src = readFileSync(join(import.meta.dir, "fastSolve.ts"), "utf8").replace(/\r\n/g, "\n");
/** one top-level function's text: from its declaration to the first closing brace at column 0 */
const fnBody = (name: string): string => {
  const at = src.indexOf(`async function ${name}(`);
  if (at < 0) throw new Error(`${name} not found in fastSolve.ts`);
  const end = src.indexOf("\n}\n", at);
  return src.slice(at, end);
};

describe("the preflop last resort per strategy", () => {
  test("the 6-max strategy never calls the heads-up last resort", () => {
    expect(fnBody("solvePreflopSixStrategy")).not.toContain("solvePreflopLastResort(");
  });
  test("its refusal says there is no last resort", () => {
    expect(fnBody("solvePreflopSixStrategy")).toContain("no heads-up last resort in the 6-max strategy");
  });
  test("the CoinPoker ring strategy keeps it", () => {
    expect(fnBody("solvePreflopCpRing")).toContain("solvePreflopLastResort(");
  });
});
