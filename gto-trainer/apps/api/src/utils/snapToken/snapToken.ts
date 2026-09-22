import { parseBetLabel } from "../parseBetLabel/parseBetLabel";

/**
 * Snap one intended aggressive URL token (R<bb>) to the closest aggressive
 * size actually offered at that node in the library tree.
 *
 * Distance is measured in LOG space (ratio), not absolute bb: raise sizes
 * scale multiplicatively, so an 8.2bb 3-bet between tree sizes 6 and 11
 * should compare 8.2/6 against 11/8.2 — absolute difference would
 * over-favour the small size as sizes grow.
 *
 * A size already within tolerance of an offered one (GTO Wizard's own loader
 * absorbs tiny drift, and rake-shaded sizes read a hair off) is reported as
 * on-tree: `snapped: false`, token unchanged. Non-aggressive tokens (F/X/C)
 * and un-sized "R" tokens pass through untouched — there is nothing to snap.
 */
export interface SnapResult {
  /** The token to use — replaced when snapped, otherwise the input. */
  token: string;
  snapped: boolean;
  /** Original / chosen bb sizes, when a snap happened. */
  from?: number;
  to?: number;
  /** The tree label the snap chose (e.g. "Raise 7.5"), when a snap happened. */
  label?: string;
  /** True when the node offered no aggressive sizes to compare against —
   *  the token can't be verified or repaired at this node. */
  unverifiable?: boolean;
  /** Log-space distance |ln(want/chosen)| to the snapped size (0 when on-tree). */
  logDist?: number;
  /** True when logDist exceeds τ — the nearest size is too far to snap safely,
   *  so the caller should re-solve at the exact size rather than reuse. */
  far?: boolean;
}

/** Relative tolerance under which a size counts as already on-tree. */
const REL_TOL = 0.025;
/** Absolute bb tolerance floor (tiny sizes: 2 vs 2.04 is the same open). */
const ABS_TOL = 0.05;
/**
 * τ — log-space distance beyond which a bet-size snap costs meaningful EV.
 * Measured empirically (river translation EV, scratchpad/translation_ev.py):
 * snapping within ~50% relative distance (log ≈ 0.4) costs < ~0.01% pot; only
 * beyond ~2x off does it reach 0.5–1.8% pot. 0.40 ≈ a 1.49x size mismatch.
 */
export const SNAP_TAU = 0.4;
/**
 * The ceiling beyond which a snap is NOT worth making at all.
 *
 * τ and this are two different questions, and conflating them cost us a real
 * hand (2026-09-21: AA in the CO facing a 21bb 3-bet, nearest tree size 12.5 —
 * log-dist 0.52, refused, no answer at all, while the tree's own node said
 * All-in 88.9% / Call 11.1% and would have been right). τ is "is this snap
 * CLEAN"; this is "is it better than nothing". Same measurement as above:
 * beyond ~2x off, translation reaches 0.5-1.8% pot and the answer stops
 * meaning much — so ln(2) is where refusing beats guessing. Between τ and
 * here, snap, say so loudly in the answer, and file it (the miss queue's
 * `size-snapped` row is the todo list of sizes worth solving for real).
 */
export const SNAP_MAX = Math.log(2);

export function snapToken(token: string, labels: string[], tau = SNAP_TAU): SnapResult {
  const m = token.match(/^R(\d+(?:\.\d+)?)$/);
  if (!m) return { token, snapped: false };
  const want = parseFloat(m[1]);
  if (!(want > 0)) return { token, snapped: false };

  const sizes: { amount: number; label: string; allin: boolean }[] = [];
  for (const label of labels) {
    const b = parseBetLabel(label);
    if (!b || (b.kind !== "bet" && b.kind !== "raise" && b.kind !== "allin")) continue;
    if (b.amount == null || !(b.amount > 0)) continue; // pct-only label — can't compare in bb
    sizes.push({ amount: b.amount, label, allin: b.kind === "allin" });
  }
  if (!sizes.length) return { token, snapped: false, unverifiable: true };

  let best = sizes[0];
  let bestDist = Math.abs(Math.log(want / best.amount));
  for (const s of sizes.slice(1)) {
    const d = Math.abs(Math.log(want / s.amount));
    if (d < bestDist) {
      best = s;
      bestDist = d;
    }
  }

  const onTree = Math.abs(best.amount - want) <= Math.max(ABS_TOL, want * REL_TOL);
  if (onTree && !best.allin) {
    // Same size, but return the TREE's canonical token (R2.52 → R2.5):
    // URL navigation absorbs the drift, but exact-token consumers (the
    // chart walks, the spot-solution API) match strings — leaving the
    // drifted token in place made "close enough" fail as "not offered".
    const canonical = Math.round(best.amount * 100) / 100;
    return { token: `R${canonical}`, snapped: false, logDist: bestDist };
  }

  const far = bestDist > tau;
  // The tree's all-in action encodes as the literal "RAI" in URLs, never
  // R<bb> — even an exact-amount match must be rewritten to load.
  if (best.allin) {
    return { token: "RAI", snapped: true, from: want, to: best.amount, label: best.label, logDist: bestDist, far };
  }
  // trim trailing zeros the same way actionToken does: 7.50 → 7.5
  const n = Math.round(best.amount * 100) / 100;
  return { token: `R${n}`, snapped: true, from: want, to: n, label: best.label, logDist: bestDist, far };
}
