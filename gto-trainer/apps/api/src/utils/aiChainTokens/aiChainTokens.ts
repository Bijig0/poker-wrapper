/**
 * GTOW capture tokens (X / C / F / R<bb> / RAI — what buildSpotSolutionTokens
 * emits per street) → the engine-style labels the aiStudy walk machinery
 * matches against ("Check" | "Call" | "Fold" | "Bet(152)" | "Raise(330)" |
 * "AllIn(9600)", amounts in chips = bb × 100).
 *
 * Bet vs Raise is positional: a wager with no outstanding wager is a Bet,
 * over an outstanding one a Raise.
 *
 * RAI CARRIES ITS AMOUNT (2026-10-03, hand 4922087007). The token itself is GTO Wizard's literal all-in token ("RAI"
 * — the /solutions URLs, feedSpot and the dashboard read it), so the amount travels beside it: `allInTo(i)` gives the
 * i-th token's all-in raise-to on the street (the table's amount, capped at the actor's own stack behind). Without it
 * an all-in was read as one for the street-entering stack of the TREE — a 28bb shove as a 97.8bb one.
 *
 * The matchers themselves are re-exported from aiStudyLine so both walkers
 * share one source of truth.
 */

export { actionKindOf, matchActionLoose, matchActionIndex } from "../aiStudyLine/aiStudyLine";

export function wagerLabelForWalk(tokens: string[], streetStack: number, allInTo?: (i: number) => number | null | undefined): string[] {
  const out: string[] = [];
  let outstanding = 0;
  tokens.forEach((tok, i) => {
    if (tok === "X") out.push("Check");
    else if (tok === "C") out.push("Call");
    else if (tok === "F") out.push("Fold");
    else if (tok === "RAI") {
      const a = allInTo?.(i);
      const to = a != null && Number.isFinite(a) && a > 0 ? a : streetStack;
      out.push(`AllIn(${Math.round(to * 100)})`);
      outstanding = Math.max(outstanding, to);
    } else if (/^R[\d.]+$/.test(tok)) {
      const to = parseFloat(tok.slice(1));
      if (!(to > 0)) throw new Error(`bad wager token "${tok}"`);
      out.push(`${outstanding > 0 ? "Raise" : "Bet"}(${Math.round(to * 100)})`);
      outstanding = to;
    } else {
      throw new Error(`unknown token "${tok}"`);
    }
  });
  return out;
}
