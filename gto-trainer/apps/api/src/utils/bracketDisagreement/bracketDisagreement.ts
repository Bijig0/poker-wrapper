/**
 * The exploitability proxy for pseudo-harmonic translation.
 *
 * For an off-tree bet size bracketed by library sizes A and B, we read hero's
 * response at both. If the two responses agree, the translated size gives the
 * same strategy for any mix weight → translation is exact and free. If they
 * differ, the error is bounded by the total-variation distance between the two
 * response distributions. That distance (scaled by pot) is the signal for when
 * a Tier-2 re-solve is worth a credit.
 *
 * Distributions are `{action, frequency}[]` with frequency in percent (0–100),
 * as returned by GtowCdp.readCombo.
 */
export interface ActionFreq {
  action: string;
  frequency: number;
}

function toMap(dist: ActionFreq[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const { action, frequency } of dist) m.set(action, (m.get(action) ?? 0) + frequency);
  return m;
}

/** Total-variation distance ½·Σ|a_i − b_i| over the union of actions (0–100). */
export function totalVariation(a: ActionFreq[], b: ActionFreq[]): number {
  const ma = toMap(a);
  const mb = toMap(b);
  const actions = new Set([...ma.keys(), ...mb.keys()]);
  let sum = 0;
  for (const act of actions) sum += Math.abs((ma.get(act) ?? 0) - (mb.get(act) ?? 0));
  return sum / 2;
}

/** Weighted blend of two response distributions (probLow on `a`, 1−probLow on `b`). */
export function blend(a: ActionFreq[], b: ActionFreq[], probLow: number): ActionFreq[] {
  const ma = toMap(a);
  const mb = toMap(b);
  const actions = new Set([...ma.keys(), ...mb.keys()]);
  const out: ActionFreq[] = [];
  for (const act of actions) {
    const f = probLow * (ma.get(act) ?? 0) + (1 - probLow) * (mb.get(act) ?? 0);
    if (f >= 0.05) out.push({ action: act, frequency: Math.round(f * 10) / 10 });
  }
  return out.sort((x, y) => y.frequency - x.frequency);
}

/**
 * Do the two bracket responses agree closely enough that translation is safe?
 * Tolerance is the max acceptable total-variation distance (percent). It scales
 * DOWN as the pot grows (errors cost more in bigger pots): tol = baseTol / max(1, pot).
 */
export function agrees(a: ActionFreq[], b: ActionFreq[], pot = 1, baseTol = 8): boolean {
  const tol = baseTol / Math.max(1, pot);
  return totalVariation(a, b) <= tol;
}
