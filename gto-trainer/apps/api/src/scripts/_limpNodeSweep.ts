/** Every ONE-limp node (a first-in limper, everyone else folded, hero next to act) and the classic BB node
 *  (limp + SB complete): equilibrium reach from the chart's own frequencies, and how much the premium mixes
 *  disagree between the 75bb and 100bb charts (mean abs diff of the "raise total" over 12 hands, in points). */
import { fetchNode } from "../services/hrc3max";
const combosOf = (h: string) => (h.length === 2 ? 6 : h.endsWith("s") ? 4 : 12);
const rangeMix = (n: any) => { const agg: Record<string, number> = {}; let tot = 0;
  for (const c of n.cells ?? []) { const w = combosOf(c.hand); tot += w; for (const [a, f] of Object.entries(c.actions ?? {})) agg[a] = (agg[a] ?? 0) + (f as number) / 100 * w; }
  return Object.fromEntries(Object.entries(agg).map(([k, v]) => [k, v / tot])); };
const raiseTotal = (acts: Record<string, number>) => Object.entries(acts).filter(([k]) => k.startsWith("Raise")).reduce((s, [, v]) => s + v, 0);
const HANDS = ["AA", "KK", "QQ", "JJ", "TT", "AKs", "AKo", "AQs", "AJs", "KQs", "A5s", "T9s"];
const SEATS = ["UTG", "HJ", "CO", "BTN", "SB", "BB"];
const lines: string[] = [];
for (let li = 0; li < 4; li++) for (let hi = li + 1; hi < 6; hi++) {
  const toks = SEATS.slice(0, hi).map((_, i) => (i === li ? "C" : "F"));
  lines.push(toks.join("-"));
}
lines.push("F-F-F-C-C", "F-F-C-F-C", "F-C-F-F-C", "C-F-F-F-C");   // BB facing a limp + SB complete
const tokName = (t: string) => (t === "F" ? "Fold" : t === "C" ? "Limp" : `Raise ${t.slice(1)}`);
console.log("line".padEnd(12), "hero", "reach%".padStart(8), " diff75v100(pts)", "  AA@100", "KK@100", "AKo@100");
for (const line of lines) {
  const toks = line.split("-");
  let reach = 1, ok = true;
  for (let i = 0; i < toks.length; i++) {
    const n: any = await fetchNode("ign200_6max_D100_olimp", toks.slice(0, i).join("-"));
    if (!n || n === "unreachable") { ok = false; break; }
    const f = rangeMix(n)[tokName(toks[i]!)]; if (f == null) { ok = false; break; } reach *= f;
  }
  const n100: any = await fetchNode("ign200_6max_D100_olimp", line);
  const n75: any = await fetchNode("ign200_6max_D75_olimp", line);
  if (!n100 || n100 === "unreachable" || !n75 || n75 === "unreachable") { console.log(line, "missing"); continue; }
  let diff = 0, cnt = 0;
  const cell = (n: any, h: string) => n.cells?.find((x: any) => x.hand === h)?.actions ?? {};
  for (const h of HANDS) { diff += Math.abs(raiseTotal(cell(n100, h)) - raiseTotal(cell(n75, h))); cnt++; }
  const fmt = (a: Record<string, number>) => { const l = a.Limp ?? 0, r = raiseTotal(a); return `L${Math.round(l)}/R${Math.round(r)}`; };
  console.log(line.padEnd(12), String(n100.pos).padEnd(4), (ok ? (reach * 100).toFixed(3) : "n/a").padStart(8), String(Math.round(diff / cnt)).padStart(16), fmt(cell(n100, "AA")).padStart(8), fmt(cell(n100, "KK")).padStart(7), fmt(cell(n100, "AKo")).padStart(8));
}
