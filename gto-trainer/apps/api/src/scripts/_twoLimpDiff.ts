/** The same 75bb-vs-100bb disagreement metric on TWO-limp nodes, for contrast with the one-limp sweep. */
import { fetchNode } from "../services/hrc3max";
const HANDS = ["AA", "KK", "QQ", "JJ", "TT", "AKs", "AKo", "AQs", "AJs", "KQs", "A5s", "T9s"];
const raiseTotal = (a: Record<string, number>) => Object.entries(a).filter(([k]) => k.startsWith("Raise")).reduce((s, [, v]) => s + v, 0);
for (const line of ["C-C", "C-C-F", "C-C-F-F", "C-C-F-F-F", "F-C-C", "F-C-C-F", "F-C-C-F-F", "F-F-C-C", "F-F-C-C-F", "F-F-C-C-C", "C-F-C-F-F"]) {
  const a: any = await fetchNode("ign200_6max_D100_olimp", line), b: any = await fetchNode("ign200_6max_D75_olimp", line);
  if (!a || a === "unreachable" || !b || b === "unreachable") { console.log(line, "missing"); continue; }
  const cell = (n: any, h: string) => n.cells?.find((x: any) => x.hand === h)?.actions ?? {};
  let d = 0; for (const h of HANDS) d += Math.abs(raiseTotal(cell(a, h)) - raiseTotal(cell(b, h)));
  console.log(line.padEnd(10), String(a.pos).padEnd(4), "diff75v100", String(Math.round(d / HANDS.length)).padStart(3), "pts  AA@100 L" + Math.round(cell(a, "AA").Limp ?? 0) + "/R" + Math.round(raiseTotal(cell(a, "AA"))), " KK@100 L" + Math.round(cell(a, "KK").Limp ?? 0) + "/R" + Math.round(raiseTotal(cell(a, "KK"))));
}
