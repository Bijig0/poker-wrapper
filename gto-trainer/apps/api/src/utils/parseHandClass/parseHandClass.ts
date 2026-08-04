/**
 * Normalize a hand input to GTO Wizard's grid class notation.
 *
 * Accepts either a specific combo ("AhKs", "7c2d") or class notation
 * ("AKo", "72s", "TT"). Returns the grid class GTO Wizard uses in its
 * range-table cell ids: pairs "AA", suited "AKs", offsuit "AKo".
 *
 * Note: within a class, specific suits collapse to the same cell — the grid
 * shows the class strategy. Suit-specific (blocker-level) reads would use the
 * combo panel; this maps a combo to its class.
 */
const RANKS = "AKQJT98765432"; // index 0 = highest

/** Higher rank first (smaller RANKS index). */
function order(r1: string, r2: string): [string, string] {
  return RANKS.indexOf(r1) <= RANKS.indexOf(r2) ? [r1, r2] : [r2, r1];
}

export function parseHandClass(input: string): string {
  const s = (input ?? "").trim();
  if (!s) throw new Error("Empty hand.");

  // specific combo: two rank+suit tokens (e.g. "AhKs")
  const full = s.match(/[2-9TJQKA][hdcs]/gi);
  if (full && full.length === 2 && s.replace(/[\s,]/g, "").length === 4) {
    const cards = full.map((c) => c[0].toUpperCase() + c[1].toLowerCase());
    if (cards[0] === cards[1]) throw new Error(`"${input}" is the same card twice.`);
    const [a, b] = cards[0][0] === cards[1][0] || RANKS.indexOf(cards[0][0]) <= RANKS.indexOf(cards[1][0])
      ? cards
      : [cards[1], cards[0]];
    const [r1, s1] = [a[0], a[1]];
    const [r2, s2] = [b[0], b[1]];
    if (r1 === r2) return r1 + r2; // pair
    return `${r1}${r2}${s1 === s2 ? "s" : "o"}`;
  }

  // class notation: two ranks + optional s/o (e.g. "AKo", "TT", "72s")
  const m = s.match(/^([2-9TJQKA])\s*([2-9TJQKA])\s*([so])?$/i);
  if (!m) {
    throw new Error(`Can't parse hand "${input}". Use e.g. "AhKs", "AKo", "TT", or "72s".`);
  }
  const [r1, r2] = order(m[1].toUpperCase(), m[2].toUpperCase());
  const suffix = m[3]?.toLowerCase();
  if (r1 === r2) return r1 + r2; // pair (suffix ignored)
  if (!suffix) {
    throw new Error(
      `Ambiguous hand "${input}" — add s/o (e.g. "${r1}${r2}s") or give specific cards (e.g. "${r1}h${r2}s").`
    );
  }
  return `${r1}${r2}${suffix}`;
}
