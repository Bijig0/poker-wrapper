/**
 * Parse an exact two-card combo ("AhKs") into GTO Wizard's combo id and its
 * grid class. Returns null when the input is class notation ("AKo", "TT") —
 * callers use that to decide between the per-combo panel and the class cell.
 *
 * GTO Wizard's combo-panel cell ids (e.g. "0_KsTh") order the two cards by
 * rank (high first), breaking ties — pairs — by suit in s > h > d > c order,
 * as rendered in the Hands aside.
 */
const RANKS = "AKQJT98765432"; // index 0 = highest
const SUITS = "shdc"; // index 0 = first in GTO Wizard's pair ordering

export interface ExactCombo {
  /** GTO Wizard combo id, e.g. "AhKs", "5s5h" (normalized card order). */
  comboId: string;
  /** The grid class the combo belongs to, e.g. "AKo", "55". */
  handClass: string;
  /** The two cards in normalized order. */
  cards: [string, string];
}

export function parseExactCombo(input: string): ExactCombo | null {
  const s = (input ?? "").trim();
  const tokens = s.match(/[2-9TJQKA][hdcs]/gi);
  if (!tokens || tokens.length !== 2 || s.replace(/[\s,]/g, "").length !== 4) return null;

  const cards = tokens.map((c) => c[0].toUpperCase() + c[1].toLowerCase());
  if (cards[0] === cards[1]) throw new Error(`"${input}" is the same card twice.`);

  const [a, b] = [...cards].sort((c1, c2) => {
    const byRank = RANKS.indexOf(c1[0]) - RANKS.indexOf(c2[0]);
    return byRank !== 0 ? byRank : SUITS.indexOf(c1[1]) - SUITS.indexOf(c2[1]);
  }) as [string, string];

  const pair = a[0] === b[0];
  const handClass = pair ? a[0] + b[0] : `${a[0]}${b[0]}${a[1] === b[1] ? "s" : "o"}`;
  return { comboId: a + b, handClass, cards: [a, b] };
}
