/** Run the SHIPPED off-tree code (gto-trainer/apps/api/src/services/offTree.ts) over export_nodes.py's nodes: the detector
 *  with the dust fix, and the soft range at the shipped T. Writes one JSON row per node it flags.
 *    bun as_built.ts <nodes.json> <out.json> */
import { readFileSync, writeFileSync } from "node:fs";
import { OFF_TREE_DUST, isOffTree, offTreeSoftT, offTreeStats, softOffTreeRange } from "../../../gto-trainer/apps/api/src/services/offTree";

const [inP, outP] = process.argv.slice(2);
const rows = JSON.parse(readFileSync(inP!, "utf-8")) as { key: string; src: string; precise: boolean; range: number[]; taken: number; pot: number;
  sols: { code: string; strategy: number[]; evs: (number | null)[] }[] }[];
const t = offTreeSoftT();
const out: unknown[] = [];
for (const r of rows) {
  const sols = r.sols.map((s) => ({ strategy: s.strategy, evs: s.evs.map((x) => (x == null ? NaN : x)) }));
  const st = offTreeStats(r.range, sols, r.taken, { dust: OFF_TREE_DUST });
  if (!isOffTree(st)) continue;
  const qre = r.range.map((w, i) => w * (sols[r.taken]!.strategy[i] ?? 0));
  const soft = softOffTreeRange(r.range, sols, r.taken, r.pot, t);
  out.push({ key: r.key, src: r.src, precise: r.precise, t, nodeFreq: st.nodeFreq, maxHand: st.maxHand,
    qreCombos: qre.reduce((a, b) => a + b, 0), ...("why" in soft ? { why: soft.why } : { softCombos: soft.combos, soft: soft.range }) });
}
writeFileSync(outP!, JSON.stringify(out));
console.log(`${rows.length} candidates -> ${out.length} flagged by the shipped detector (T = ${t * 100}% of the pot) -> ${outP}`);
