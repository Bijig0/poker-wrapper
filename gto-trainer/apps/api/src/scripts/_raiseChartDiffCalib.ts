/** Calibration: the same 75bb-vs-100bb disagreement metric on ordinary RAISE-chart nodes (well-trodden lines). */
import { fetchNode } from "../services/hrc3max";
const HANDS = ["AA", "KK", "QQ", "JJ", "TT", "AKs", "AKo", "AQs", "AJs", "KQs", "A5s", "T9s"];
const aggr = (a: Record<string, number>) => Object.entries(a).filter(([k]) => /^Raise|^All/.test(k)).reduce((s, [, v]) => s + v, 0);
for (const [line, what] of [["", "UTG first in"], ["F-F-F", "BTN first in"], ["F-F-F-F", "SB first in"], ["F-F-R2.5", "BTN vs CO open"], ["F-F-R2.5-F-F", "BB vs CO open"], ["F-F-F-R2.5-F", "BB vs BTN open"], ["F-F-F-R2.5-R9", "BTN vs SB 3-bet"], ["R2.5-F-F-F-F", "BB vs UTG open"]] as [string, string][]) {
  const a: any = await fetchNode("ign200_6max_D100_o2_5", line), b: any = await fetchNode("ign200_6max_D75_o2_5", line);
  if (!a || a === "unreachable" || !b || b === "unreachable") { console.log(line, "missing"); continue; }
  const cell = (n: any, h: string) => n.cells?.find((x: any) => x.hand === h)?.actions ?? {};
  let d = 0; for (const h of HANDS) d += Math.abs(aggr(cell(a, h)) - aggr(cell(b, h)));
  console.log((line || "(root)").padEnd(16), what.padEnd(16), String(a.pos).padEnd(4), "diff75v100", String(Math.round(d / HANDS.length)).padStart(3), "pts");
}
