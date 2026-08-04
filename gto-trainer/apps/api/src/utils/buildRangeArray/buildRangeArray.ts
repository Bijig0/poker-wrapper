import { COMBOS } from "../comboIndex/comboIndex";
import { expandRange, isShorthandRange } from "../rangeExpander";

/**
 * Turn a human range spec into GTO Wizard's 1326-weight range array — the shape
 * `custom-trees` wants in `players[].range`. Accepts:
 *   - shorthand ("22+,A2s+,KQs")           → expanded then weighted 1
 *   - explicit class list ("AA,AKs:0.8,72o")→ per-class weights
 *   - "full" / "*" / "100%"                 → every combo at weight 1
 * Unlisted classes get weight 0. Combo order matches comboIndex (verified
 * against the spot-solution response by board card-removal).
 */
export function buildRangeArray(spec: string): number[] {
  const s = spec.trim();
  if (!s || /^(full|\*|100%?|any)$/i.test(s)) return new Array(1326).fill(1);

  const expanded = isShorthandRange(s) ? expandRange(s) : s;
  const weights: Record<string, number> = {};
  for (const part of expanded.split(",").map((p) => p.trim()).filter(Boolean)) {
    const [cls, w] = part.split(":");
    if (!cls) continue;
    const wt = w != null ? parseFloat(w) : 1;
    weights[cls] = Number.isFinite(wt) ? Math.max(0, Math.min(1, wt)) : 1;
  }
  return COMBOS.map((c) => weights[c.cls] ?? 0);
}

/** Total combos covered by a 1326-weight range (for display / sanity). */
export const rangeCombos = (range: number[]): number => range.reduce((s, w) => s + w, 0);
