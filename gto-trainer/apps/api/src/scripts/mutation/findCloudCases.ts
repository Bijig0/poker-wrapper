/**
 * Harness cases whose postflop decision the offline sweep can only mark cloud-gated, by the reason it was gated — the
 * candidates for live verification of the AI-piece paths (part B). Offline.
 *
 *   bun src/scripts/mutation/findCloudCases.ts --seeds=400 --ops=hero-deviates,jam,thin-table,limps
 */
process.env.ANSWERS_DB_PATH ??= ":memory:";
import { harnessEnv, runCase, type Op } from "../mutationHarness";

const arg = (k: string, d: string) => (process.argv.find((a) => a.startsWith(`--${k}=`)) ?? `--${k}=${d}`).split("=")[1]!;
const seeds = Number(arg("seeds", "400")), seed0 = Number(arg("seed0", "1"));
const ops = arg("ops", "hero-deviates,jam,thin-table,limps,short-seat").split(",") as Op[];
const CLASSES: [string, RegExp][] = [
  ["deviation → AI flop ranges", /OFF THE CHART \(hero's own line\)/],
  ["pinned chart cannot hold → AI", /cannot hold what followed|chart hero's preflop decisions were read on/],
  ["mis-mapped jam → exact tree", /all-in not in the chart/],
  ["kept callers → AI piece", /LINE KEPT AS THE HAND WAS READ.*AI preflop tree answers|tree cannot hold the line with it kept/],
  ["chart changed under hero → AI", /CHART CHANGED UNDER HERO/],
  ["size past τ → exact tree", /size past τ/],
];
const restore = harnessEnv();
const found: Record<string, string[]> = {};
const log = console.log; console.log = () => {};
for (let s = seed0; s < seed0 + seeds; s++) for (const op of ops) {
  const r = await runCase(s, [op]);
  for (const v of r.verdicts) {
    if (v.verdict !== "cloud-gated") continue;
    for (const [name, re] of CLASSES) if (re.test(v.reason ?? "")) {
      const list = (found[name] ??= []);
      const tag = `${s}:${op} (${v.street})`;
      if (list.length < 6 && !list.some((x) => x.startsWith(`${s}:${op}`))) list.push(tag);
    }
  }
}
console.log = log;
restore();
for (const [k, v] of Object.entries(found)) console.log(`${k}: ${v.join(", ")}`);
process.exit(0);
