/**
 * GTO Wizard's 1326-combo ordering, reverse-engineered and verified against the
 * spot-solution API by card-removal (every board-blocked combo weight is 0).
 *
 * Card index = rank*4 + suit, with rank 2..A → 0..12 and suit c,d,h,s → 0..3.
 * Combos are enumerated with the higher card index second and ordered by the
 * standard pair index: for cards a < b, index = C(b,2) + a = b*(b-1)/2 + a.
 *
 * `spot-solution`'s `strategy`, `evs`, and each `players_info[].range` are all
 * 1326-length arrays in this order.
 */

export const RANKS = "23456789TJQKA"; // rank 0..12
export const SUITS = "cdhs"; // suit 0..3

export interface Combo {
  /** e.g. "AsKh" (higher card index first for readability) */
  hand: string;
  /** 169-class label, e.g. "AKs", "TT", "72o" */
  cls: string;
  cards: [string, string];
}

const cardStr = (idx: number): string => RANKS[Math.floor(idx / 4)]! + SUITS[idx % 4]!;

export const cardIndex = (card: string): number => {
  const r = RANKS.indexOf(card[0]!);
  const s = SUITS.indexOf(card[1]!);
  if (r < 0 || s < 0) throw new Error(`bad card: ${card}`);
  return r * 4 + s;
};

/** Index into a 1326 array for two cards (any order). */
export const comboIndex = (cardA: string, cardB: string): number => {
  let a = cardIndex(cardA);
  let b = cardIndex(cardB);
  if (a === b) throw new Error(`duplicate card: ${cardA}`);
  if (a > b) [a, b] = [b, a];
  return (b * (b - 1)) / 2 + a;
};

/** The 169-class label for two card strings, e.g. ("As","Kh") → "AKo". */
export const classOf = (cardA: string, cardB: string): string => {
  const r1 = RANKS.indexOf(cardA[0]!);
  const r2 = RANKS.indexOf(cardB[0]!);
  const suited = cardA[1] === cardB[1];
  const hi = r1 >= r2 ? cardA[0]! : cardB[0]!;
  const lo = r1 >= r2 ? cardB[0]! : cardA[0]!;
  if (r1 === r2) return hi + lo; // pair
  return hi + lo + (suited ? "s" : "o");
};

/** The full 1326-combo table in GTOW order (index i → combo). Built once. */
export const COMBOS: readonly Combo[] = (() => {
  const out: Combo[] = new Array(1326);
  for (let b = 0; b < 52; b++) {
    for (let a = 0; a < b; a++) {
      const i = (b * (b - 1)) / 2 + a;
      const ca = cardStr(a);
      const cb = cardStr(b);
      // higher card first for the readable hand string
      out[i] = { hand: cb + ca, cls: classOf(ca, cb), cards: [cb, ca] };
    }
  }
  return out;
})();

/**
 * Collapse a 1326 weight array into 169-class aggregates. Returns each class's
 * total weight and its combo count so callers can render frequencies or feed a
 * class-level range. `weights[i]` is combo i's weight in [0,1].
 */
export const toClassWeights = (weights: readonly number[]): Record<string, { weight: number; combos: number }> => {
  const acc: Record<string, { weight: number; combos: number }> = {};
  for (let i = 0; i < COMBOS.length; i++) {
    const w = weights[i] ?? 0;
    if (w <= 0) continue;
    const cls = COMBOS[i]!.cls;
    (acc[cls] ??= { weight: 0, combos: 0 }).weight += w;
    acc[cls]!.combos += 1;
  }
  return acc;
};

/**
 * A 1326 weight array as a solver-ready range string: "AsKh:1.0,AsKd:0.5,…"
 * (only nonzero combos). Feeds straight into postflop-solver's range input.
 */
export const toRangeString = (weights: readonly number[]): string => {
  const parts: string[] = [];
  for (let i = 0; i < COMBOS.length; i++) {
    const w = weights[i] ?? 0;
    if (w > 0) parts.push(`${COMBOS[i]!.hand}:${w.toFixed(4).replace(/\.?0+$/, "")}`);
  }
  return parts.join(",");
};
