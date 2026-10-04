/**
 * THE TIGHTEST OF THE FITS (2026-10-04, hand 4922379136, Brady: "an added player means a tighter range is needed").
 *
 * A line the tree cannot hold — a second cold-caller, a second limper — is read with one of those players folded out
 * (utils/fitLine). Each such FIT is a spot with one player fewer than the table, and it is too loose, measured in our
 * own 6-max charts where the truth exists one player down (229 trusted node pairs, 24 charts, BB closing): with the
 * caller simply removed the BB folds 74.9% where he folds 80.6% with him in — 7.0% of all hands continue that the true
 * spot folds, 1.2% the other way; suited hands 15.0%, offsuit 4.8%, pairs 1.2%. WHICH caller is removed moves the
 * answer more than anything: 100bb, UTG opens 2x, BB with KTo calls 95% when the SB caller is kept and folds 93% when
 * the CO cold-caller is.
 *
 * So when the tree holds more than one fit, hero's mix is not any single one: he folds as often as the MOST folding
 * fit, raises as often as the LEAST raising one, and the passive action takes the rest — the rule the 4-way postflop
 * collapse was measured on (services/multiwayCollapse.blendStrategies, 3.7x better than averaging; this module calls
 * it, so the two cannot drift). On the one 4-way truth we hold preflop — the SB behind two limpers in the limp trees,
 * 58 nodes — it is the nearest of the rules tried (L1 8.6 against 9.1 for folding the earliest limper).
 *
 * It still leans loose: every fit is three players standing in for four. And it replaces the dead-money tree (the
 * folded player's chips as `pot` on the tree), which pushed the other way — chips in the pot before the first action
 * are an ante: every seat's strategy changes from the root, the opener's real raise was 0.06% of his range there, and
 * hero's K7o read "Call 100%" where both plain fits fold it.
 */
import { blendStrategies } from "../../services/multiwayCollapse";

export interface MixAction { action: string; frequency: number }

const kindOf = (label: string): "fold" | "passive" | "aggr" =>
  /^fold/i.test(label) ? "fold" : /^(call|check)/i.test(label) ? "passive" : "aggr";

/** fold / passive / aggression of one mix, as fractions summing to 1 (null: the mix carries no weight) */
function split(mix: MixAction[]): { fold: number; passive: number; aggr: number } | null {
  let fold = 0, passive = 0, aggr = 0;
  for (const a of mix) {
    const f = Number.isFinite(a.frequency) && a.frequency > 0 ? a.frequency : 0;
    const k = kindOf(a.action);
    if (k === "fold") fold += f; else if (k === "passive") passive += f; else aggr += f;
  }
  const sum = fold + passive + aggr;
  return sum > 0 ? { fold: fold / sum, passive: passive / sum, aggr: aggr / sum } : null;
}

/**
 * Hero's mix over several fits of one line, each given as its own actions for hero's combo (labels "Fold", "Call",
 * "Check", "Raise 7", "All-in"; frequencies in any one scale). Returns PERCENT, in the order fold, passive, raises.
 * The raise sizes are the least-raising fit's own, in its proportions. One usable fit comes back as it is (in
 * percent); none → an empty list.
 */
export function blendFitMixes(mixes: MixAction[][]): MixAction[] {
  const parts = mixes.map((m) => ({ m, s: split(m) })).filter((x): x is { m: MixAction[]; s: NonNullable<ReturnType<typeof split>> } => !!x.s);
  if (!parts.length) return [];
  const passiveLabel = parts.map((p) => p.m.find((a) => kindOf(a.action) === "passive")?.action).find(Boolean) ?? null;
  // a node that offers hero no call or check (fold or raise only) has no passive action to absorb the rest:
  // blendStrategies then renormalises fold and raise, as it does for a postflop menu without one
  const codes = passiveLabel ? ["F", "C", "R"] : ["F", "R"];
  const blended = blendStrategies(codes, parts.map((p) => (passiveLabel ? [[p.s.fold], [p.s.passive], [p.s.aggr]] : [[p.s.fold], [p.s.aggr]]))).map((a) => a[0] ?? 0);
  const fold = blended[0] ?? 0, passive = passiveLabel ? blended[1] ?? 0 : 0, aggr = blended[passiveLabel ? 2 : 1] ?? 0;
  // the raise sizes of the fit that raises least (the one the blend's aggression IS), in its own proportions
  const least = parts.reduce((b, p) => (p.s.aggr < b.s.aggr ? p : b));
  const raises = least.m.filter((a) => kindOf(a.action) === "aggr" && a.frequency > 0);
  const raiseSum = raises.reduce((s, a) => s + a.frequency, 0);
  const out: MixAction[] = [];
  if (parts.some((p) => p.m.some((a) => kindOf(a.action) === "fold"))) out.push({ action: "Fold", frequency: fold * 100 });
  if (passiveLabel) out.push({ action: passiveLabel, frequency: passive * 100 });
  if (raiseSum > 0) for (const a of raises) out.push({ action: a.action, frequency: (aggr * 100 * a.frequency) / raiseSum });
  return out;
}
