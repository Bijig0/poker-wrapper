/**
 * A/B the 6-max ring preflop path: baked SQLite vs the :8777 chart server.
 *
 *   bun src/scripts/benchPreflop6max.ts            # local DB (default)
 *   HRC6MAX_DB=off bun src/scripts/benchPreflop6max.ts   # every node over HTTP
 *
 * Times what a real decision costs — resolveChart6max (which opens the ROOT of
 * each candidate chart, and is where most of the server-path latency lives) plus
 * the line walk — over several charts, so the cache thrash the server suffers
 * when a session moves between trees actually shows up. Run the two modes back
 * to back; the server one is only honest on trees it has not just opened.
 */
import { chartFor6max, resolveChart6max, nodeGetter, evenChartId, unevenChartId } from "../services/hrc6max";
import { walk3max } from "../services/hrc3max";
import { hrc6maxDb } from "../services/hrc6maxDb";

const CASES: { label: string; id: string; tokens: string[] }[] = [
  { label: "UTG open 2.5x, folded to BTN", id: evenChartId(100, 2.5), tokens: ["R2.5", "F", "F"] },
  { label: "root (hero UTG first in)", id: evenChartId(100, 2.5), tokens: [] },
  { label: "3x open, BB 3-bets", id: evenChartId(100, 3), tokens: ["R3", "F", "F", "F", "F"] },
  { label: "limped pot", id: evenChartId(100, "limp"), tokens: ["C", "C", "F"] },
  { label: "short BB 50bb, 2.5x", id: unevenChartId(50, "BB", 2.5), tokens: ["R2.5", "F"] },
  { label: "short BTN 30bb, 3x", id: unevenChartId(30, "BTN", 3), tokens: ["R3", "F", "F"] },
  { label: "150bb even, 2.5x", id: evenChartId(150, 2.5), tokens: ["R2.5", "F", "F", "F"] },
];

const mode = process.env.HRC6MAX_DB === "off" ? ":8777 (server)" : "baked SQLite";
console.log(`mode: ${mode}   trees baked here: ${hrc6maxDb.size}`);
console.log();

let total = 0;
for (const c of CASES) {
  const choice = { candidates: [c.id], id: c.id, site: "ign200", depth: 100, shortDepth: 100,
    shortSeat: "EQ" as const, openSize: 2.5 as number | "limp", note: null, beyondLadder: null };
  const t0 = Date.now();
  const resolved = await resolveChart6max(choice);
  const tResolve = Date.now() - t0;
  if (resolved === "unreachable" || resolved === null) {
    console.log(`  ${c.label.padEnd(34)} ${c.id}: ${resolved ?? "no chart"}`);
    continue;
  }
  const t1 = Date.now();
  const walk = await walk3max(c.tokens, nodeGetter(resolved.id));
  const tWalk = Date.now() - t1;
  total += tResolve + tWalk;
  const cells = walk.ok ? walk.node.cells.length : 0;
  console.log(`  ${c.label.padEnd(34)} resolve ${String(tResolve).padStart(6)}ms  walk ${String(tWalk).padStart(5)}ms`
    + `  ${walk.ok ? `${cells} hand classes` : `walk: ${walk.reason}`}`);
}
console.log();
console.log(`  total ${total}ms over ${CASES.length} decisions`);

void chartFor6max;
