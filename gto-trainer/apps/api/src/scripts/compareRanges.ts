/**
 * Range Compare — side-by-side comparison of two actions at the node currently
 * open in the GTO Wizard desktop app.
 *
 * Scrapes the live strategy grid over CDP, then writes a self-contained HTML
 * report (two range heatmaps, a per-hand size-skew grid, GTO Wizard's own
 * composition buckets, and top-skew lists) and opens it in the browser.
 *
 * Usage (from apps/api):
 *   bun run compare:ranges              # two most-used actions at the node
 *   bun run compare:ranges 75 50        # Bet 75% vs Bet 50%
 *   bun run compare:ranges b33 check    # any two actions; "x"/"jam" work too
 *
 * GTO Wizard must be running with remote debugging:
 *   open -a "GTO Wizard" --args --remote-debugging-port=9222
 */

import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { gtowCdp } from "../services/gtowCdp";
import { matchActionLabel } from "../utils/matchActionLabel/matchActionLabel";
import { compareActionRanges } from "../utils/compareActionRanges/compareActionRanges";
import {
  buildRangeCompareHtml,
  shortActionLabel,
} from "../utils/buildRangeCompareHtml/buildRangeCompareHtml";

function die(msg: string): never {
  console.error(`✗ ${msg}`);
  process.exit(1);
}

const [queryA, queryB] = Bun.argv.slice(2);

if (!(await gtowCdp.isConnected())) {
  die(
    `GTO Wizard isn't reachable on the debug port. Launch it with:\n  open -a "GTO Wizard" --args --remote-debugging-port=9222`
  );
}

// Filters change the cell gradients, so always scrape from the unfiltered grid.
await gtowCdp.clearActionFilters();
const node = await gtowCdp.readNodeStrategy();
if (!node.actions.length) {
  die("No strategy legend on screen — open a solved node in GTO Wizard's Study view first.");
}
const labels = node.actions.map((a) => a.action);

const resolve = (q: string) =>
  matchActionLabel(q, labels) ??
  die(`No action matches "${q}" here. Available: ${labels.join(" · ")}`);

const pickLabels = (): [string, string] => {
  if (queryA && queryB) return [resolve(queryA), resolve(queryB)];
  if (queryA) die(`Give two actions (or none for the top two). Available: ${labels.join(" · ")}`);
  // default: the two most-used actions at this node
  const top = [...node.actions].sort((x, y) => (y.rangePct ?? 0) - (x.rangePct ?? 0)).slice(0, 2);
  if (top.length < 2 || !(top[1].rangePct ?? 0)) {
    die(`Fewer than two used actions at this node. Available: ${labels.join(" · ")}`);
  }
  return [top[0].action, top[1].action];
};
const [labelA, labelB] = pickLabels();
if (labelA === labelB) die("Pick two different actions.");

const [bucketsA, bucketsB] = [
  await gtowCdp.readActionBuckets(labelA),
  await gtowCdp.readActionBuckets(labelB),
];

const summaryOf = (label: string, buckets: { rows?: { section: string; name: string; pct: number }[] }) => {
  const legend = node.actions.find((a) => a.action === label)!;
  return { label, rangePct: legend.rangePct, combos: legend.combos, buckets: buckets.rows ?? [] };
};

const cmp = compareActionRanges(node.cells, labelA, labelB);
if (!cmp.rows.length) {
  die(`Neither "${shortActionLabel(labelA)}" nor "${shortActionLabel(labelB)}" is used by any hand at this node.`);
}

const now = new Date();
const stamp = now.toISOString().slice(0, 16).replace("T", " ");
const html = buildRangeCompareHtml({
  meta: {
    board: node.board,
    position: node.position,
    potLabel: node.potLabel,
    url: node.url,
    generatedAt: stamp,
  },
  a: summaryOf(labelA, bucketsA),
  b: summaryOf(labelB, bucketsB),
  cells: node.cells,
  cmp,
});

const slug = (s: string) => shortActionLabel(s).toLowerCase().replace(/[^a-z0-9]+/g, "");
const outDir = join(import.meta.dir, "../../../../logs/range-compare");
await mkdir(outDir, { recursive: true });
const file = join(
  outDir,
  `${node.board ?? "node"}_${(node.position ?? "hero").toLowerCase()}_${slug(labelA)}-vs-${slug(labelB)}_${now
    .toISOString()
    .slice(0, 19)
    .replace(/[:T]/g, "-")}.html`
);
await Bun.write(file, html);
Bun.spawn(["open", file]);

const short = (l: string) => shortActionLabel(l);
console.log(`✓ ${short(labelA)} vs ${short(labelB)} — ${node.position} on ${node.board ?? "?"} (pot ${node.potLabel ?? "?"})`);
for (const label of [labelA, labelB]) {
  const s = node.actions.find((a) => a.action === label)!;
  console.log(`  ${short(label).padEnd(10)} ${s.rangePct ?? "?"}% of range · ${s.combos ?? "?"} combos`);
}
console.log(`  mix both: ${cmp.both} hands · only ${short(labelA)}: ${cmp.onlyA} · only ${short(labelB)}: ${cmp.onlyB}`);
const fmt = (r: { hand: string; diff: number }) => `${r.hand} ${r.diff > 0 ? "+" : ""}${r.diff}`;
console.log(`  top ${short(labelA)} leans: ${cmp.skewToA.slice(0, 5).map(fmt).join(", ")}`);
console.log(`  top ${short(labelB)} leans: ${cmp.skewToB.slice(0, 5).map(fmt).join(", ")}`);
console.log(`  report: ${file}`);
process.exit(0); // the CDP websocket would otherwise keep the process alive
