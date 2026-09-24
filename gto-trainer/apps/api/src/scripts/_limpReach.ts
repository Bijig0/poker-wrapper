/** How often does equilibrium even REACH the limp-chart nodes we answer from? Reach = product of the range-wide
 *  frequency of each action on the line (combo-weighted from the cells, card removal ignored). */
import { fetchNode } from "../services/hrc3max";
const combosOf = (h: string) => (h.length === 2 ? 6 : h.endsWith("s") ? 4 : 12);
function rangeMix(n: any, weights?: Record<string, number>) {
  const agg: Record<string, number> = {}; let tot = 0;
  for (const c of n.cells ?? []) {
    const w = (weights ? (weights[c.hand] ?? 0) : 1) * combosOf(c.hand);
    if (!w) continue;
    tot += w;
    for (const [a, f] of Object.entries(c.actions ?? {})) agg[a] = (agg[a] ?? 0) + (f as number) / 100 * w;
  }
  return Object.fromEntries(Object.entries(agg).map(([k, v]) => [k, v / tot]));
}
const ACTORS = ["UTG", "HJ", "CO", "BTN", "SB", "BB"];
const tokName = (t: string) => (t === "F" ? "Fold" : t === "C" ? "Limp" : `Raise ${t.slice(1)}`);
for (const id of ["ign200_6max_D100_olimp", "ign200_6max_D75_olimp", "ign200_6max_D100_o2_5"]) {
  for (const line of ["F-F-C-C", "F-F-F-C", "F-F-R2.5-C", "F-F-C-C-C-X"]) {
    const toks = line.split("-");
    let reach = 1; const steps: string[] = [];
    let ok = true;
    for (let i = 0; i < toks.length; i++) {
      const prefix = toks.slice(0, i).join("-");
      const n: any = await fetchNode(id, prefix);
      if (!n || n === "unreachable") { ok = false; steps.push(`${prefix || "root"}: missing`); break; }
      const mix = rangeMix(n);   // every actor starts with the full range at his first action
      const name = tokName(toks[i]!);
      const f = mix[name];
      if (f == null) { ok = false; steps.push(`${n.pos} has no ${name} at ${prefix || "root"} (have ${Object.keys(mix).join(",")})`); break; }
      // a later action by a seat that already acted (BB check after limps) is conditional — its range is the
      // hands that took the earlier action; approximate with the node's own cells, which are that seat's cells
      reach *= f; steps.push(`${n.pos} ${name} ${(f * 100).toFixed(2)}%`);
    }
    console.log(`${id}  ${line.padEnd(12)} reach ≈ ${ok ? (reach * 100).toFixed(4) + "%" : "n/a"}   [${steps.join(" → ")}]`);
  }
}
