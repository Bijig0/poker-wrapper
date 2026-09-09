import { fetchNode } from "../services/hrc3max";
import { gtowApi } from "../services/gtowApi";
import { buildRangeArray } from "../utils/buildRangeArray/buildRangeArray";
import { reconstructFlopRanges, classWeightsToSpec } from "../utils/reconstructFlopRanges/reconstructFlopRanges";
import { comboIndex } from "../utils/comboIndex/comboIndex";

const recon = await reconstructFlopRanges("R2.5-F-C".split("-"), async (l) => {
  const n = await fetchNode("ign200_3maxasym_D100_s100_eq", l);
  return n === "unreachable" ? null : n;
});
if (!recon.ok) throw new Error(recon.reason);
const oop = buildRangeArray(classWeightsToSpec(recon.ranges["BB"]!));
const ip = buildRangeArray(classWeightsToSpec(recon.ranges["BTN"]!));
const tree = { board: "Kc7d2h", pot: 5.5, stack: 97.5, oopRange: oop, ipRange: ip,
  oopPos: "BB", ipPos: "BTN", startingStreet: "FLOP", flopActions: "", turnActions: "", riverActions: "" };
const root: any = await gtowApi.customSolve(tree as any);
if (!root?.ok) throw new Error(String(root?.error));
const sol = root.data;
// root actor = OOP (BB). Print EV of a few known combos: sum over actions of freq*ev, and max ev.
for (const cards of [["Kh","Ks"],["7h","7s"],["6c","6d"],["Ah","5h"]]) {
  const idx = comboIndex(cards[0]!, cards[1]!);
  let mix = 0, best = -1e9, tot = 0;
  for (const a of sol.action_solutions ?? []) {
    const f = a.strategy?.[idx] ?? 0, e = a.evs?.[idx];
    if (e != null) { mix += f * e; best = Math.max(best, e); tot += f; }
  }
  console.log(`${cards.join("")}: mixEV=${mix.toFixed(2)} bestEV=${best.toFixed(2)} (freqsum ${tot.toFixed(2)})`);
}
console.log("pot was 5.5bb, stacks 97.5 — if EVs are 'share of pot + net future', strong hands should be ~3-8bb");
