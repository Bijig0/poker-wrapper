/**
 * Pseudo-harmonic action translation (Ganzfried & Sandholm, IJCAI 2013).
 *
 * When facing an off-tree bet size x that sits between two abstraction sizes
 * A < x < B, this gives the probability of mapping x DOWN to the smaller size A
 * (and 1 - that of mapping up to B). Sizes are expressed as fractions of the pot.
 * The (1 + A)/(1 + x) factor is the pot-geometry correction over the pure
 * harmonic (1/x) mapping — what matters is the bet relative to the final pot.
 *
 *   f_A(x) = (B - x)(1 + A) / ((B - A)(1 + x))
 *
 * It is scale-invariant, monotone, and boundary-consistent (x=A → 1, x=B → 0),
 * and is the (near-)unexploitable mapping in the no-limit clairvoyance game.
 */
export function pseudoHarmonicProbLow(x: number, A: number, B: number): number {
  if (!(B > A)) throw new Error(`Bracket must have A < B (got A=${A}, B=${B}).`);
  if (x <= A) return 1;
  if (x >= B) return 0;
  return ((B - x) * (1 + A)) / ((B - A) * (1 + x));
}

export interface Bracket {
  low: number;
  high: number;
  /** true when x is outside the available sizes (clamped to a single size). */
  clamped: boolean;
}

/**
 * Find the two available sizes that bracket x (largest ≤ x and smallest ≥ x),
 * as pot fractions. Below the smallest / above the largest, both collapse to the
 * nearest available size (clamped) — you can't translate past the abstraction.
 */
export function bracket(x: number, sizes: number[]): Bracket {
  const sorted = [...new Set(sizes)].sort((a, b) => a - b);
  if (!sorted.length) throw new Error("No available sizes to bracket against.");
  if (x <= sorted[0]) return { low: sorted[0], high: sorted[0], clamped: true };
  if (x >= sorted[sorted.length - 1]) {
    const top = sorted[sorted.length - 1];
    return { low: top, high: top, clamped: true };
  }
  let low = sorted[0];
  let high = sorted[sorted.length - 1];
  for (const s of sorted) {
    if (s <= x && s > low) low = s;
    if (s >= x && s < high) high = s;
  }
  return { low, high, clamped: false };
}
