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
 */
export function streetFixedPcts(tokens: string[], potStart: number): StreetFixedPcts {
  const inv: [number, number] = [0, 0];
  const pcts: string[] = [];
  const sizesBb: number[] = [];
  let actor: 0 | 1 = 0;
  for (const tok of tokens) {
    const x = wagerBb(tok);
    if (x != null) {
      const own = inv[actor];
      const outstanding = inv[1 - actor]!;
      const toCall = outstanding - own;
      const potNow = potStart + inv[0] + inv[1];
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
      inv[actor] = inv[1 - actor]!;
    }
    // Check/Fold commit nothing
    actor = (1 - actor) as 0 | 1;
  }
  return { pcts, sizesBb };
}
