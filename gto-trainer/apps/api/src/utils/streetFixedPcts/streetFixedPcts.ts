/**
 * Per-raise-level pot percentages for one street's action line — the FIXED
 * sizing config that lets a GTOW custom solve contain the line's EXACT wager
 * sizes (including arbitrary user-typed ones that no AUTOMATIC tree offers).
 *
 * Tokens are the study UI's engine labels ("Check" | "Call" | "Fold" |
 * "Bet(750)" | "Raise(2100)" | "AllIn(9800)"; wager amounts in chips = bb×100,
 * amounts are the street's raise-to commit). HU postflop: OOP acts first,
 * strict alternation.
 *
 * GTOW's % convention: a bet of P% wagers P% of the current pot; a raise of P%
 * raises BY P% of the pot-after-call on top of the call — so
 *   P = 100 · (X − L) / (potNow + toCall)
 * where X = raise-to, L = the outstanding wager, toCall = L − own commit
 * (a first bet is the L = toCall = 0 case of the same formula).
 */

const WAGER_RE = /^(?:Bet|Raise|AllIn)\((\d+(?:\.\d+)?)\)$/;

/** Wager size in bb from an engine label, or null for Check/Call/Fold/cards. */
export const wagerBb = (token: string): number | null => {
  const m = token.match(WAGER_RE);
  return m ? Number(m[1]) / 100 : null;
};

export interface StreetFixedPcts {
  /** One "<pct>%" per aggressive level, in order (bet, raise, reraise, …). */
  pcts: string[];
  /** The wagers' raise-to sizes in bb, same order. */
  sizesBb: number[];
}

/**
 * @param tokens one street's action tokens (no dealt cards)
 * @param potStart pot in bb entering the street
 * @param actors who acts on each token, as seat indices in acting order (0 = OOP). Omitted = heads-up strict
 *   alternation. A 3-way street (since 2026-09-19) passes the rotation the walker computed — folds mean the
 *   seats do not simply alternate, and the outstanding wager is the most any seat has put in, not "the other's".
 */
export function streetFixedPcts(tokens: string[], potStart: number, actors?: number[]): StreetFixedPcts {
  const n = actors ? Math.max(1, ...actors) + 1 : 2;
  const inv: number[] = new Array(n).fill(0);
  const pcts: string[] = [];
  const sizesBb: number[] = [];
  let alt: 0 | 1 = 0;
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i]!;
    const actor = actors ? actors[i]! : alt;
    const x = wagerBb(tok);
    const outstanding = Math.max(...inv);
    if (x != null) {
      const own = inv[actor]!;
      const toCall = outstanding - own;
      const potNow = potStart + inv.reduce((s, v) => s + v, 0);
      const denom = potNow + toCall;
      const pct = (100 * (x - outstanding)) / denom;
      if (!(pct > 0)) {
        throw new Error(
          `wager to ${x}bb isn't a raise over ${outstanding}bb (pot ${potNow.toFixed(1)}bb)`,
        );
      }
      pcts.push(`${Math.round(pct * 10) / 10}%`);
      sizesBb.push(x);
      inv[actor] = x;
    } else if (tok === "Call") {
      inv[actor] = outstanding;
    }
    // Check/Fold commit nothing
    alt = (1 - alt) as 0 | 1;
  }
  return { pcts, sizesBb };
}
