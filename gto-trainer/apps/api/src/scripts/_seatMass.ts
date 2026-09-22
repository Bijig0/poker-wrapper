/** Per-seat range mass (combos) for each calibration line — joins into analyzeCollapse.py's ghost-selection rules. */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fetchNode6max } from "../services/hrc6maxDb";
import { reconstructFlopRanges, classWeightsToSpec } from "../utils/reconstructFlopRanges/reconstructFlopRanges";
import { buildRangeArray } from "../utils/buildRangeArray/buildRangeArray";
const lines = readFileSync(join(import.meta.dir, "collapse_lines.jsonl"), "utf8").split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l));
const out: Record<string, Record<string, number>> = {};
for (const line of lines) {
  const r = await reconstructFlopRanges(line.tokens, async (l) => {
    const x = await fetchNode6max(line.src, l); return x === "unreachable" ? null : x;
  }, { maxPlayers: 3, borrowCaller: true });
  if (!r.ok) continue;
  const m: Record<string, number> = {};
  for (const p of Object.keys(r.ranges)) m[p] = Math.round(buildRangeArray(classWeightsToSpec(r.ranges[p]!)).reduce((s, x) => s + x, 0) * 100) / 100;
  out[`${line.tokens.join("-")}|${line.src}`] = m;
}
writeFileSync(join(import.meta.dir, "collapse_seat_mass.json"), JSON.stringify(out, null, 1));
console.log(Object.keys(out).length, "lines");
for (const [k, v] of Object.entries(out)) console.log(" ", k.split("|")[0], JSON.stringify(v));
