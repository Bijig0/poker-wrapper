/**
 * GTOW capture tokens (X / C / F / R<bb> / RAI — what buildSpotSolutionTokens
 * emits per street) → the engine-style labels the aiStudy walk machinery
 * matches against ("Check" | "Call" | "Fold" | "Bet(152)" | "Raise(330)" |
 * "AllIn(9600)", amounts in chips = bb × 100).
 *
 * Bet vs Raise is positional: a wager with no outstanding wager is a Bet,
 * over an outstanding one a Raise. RAI's amount is the street-entering
 * effective stack (all-in raise-to = commit-so-far + everything behind).
 *
 * The matchers themselves are re-exported from aiStudyLine so both walkers
 * share one source of truth.
 */

export { actionKindOf, matchActionLoose, matchActionIndex } from "../aiStudyLine/aiStudyLine";

export function wagerLabelForWalk(tokens: string[], streetStack: number): string[] {
  const out: string[] = [];
  let outstanding = 0;
  for (const tok of tokens) {
    if (tok === "X") out.push("Check");
    else if (tok === "C") out.push("Call");
    else if (tok === "F") out.push("Fold");
    else if (tok === "RAI") {
      out.push(`AllIn(${Math.round(streetStack * 100)})`);
      outstanding = streetStack;
    } else if (/^R[\d.]+$/.test(tok)) {
      const to = parseFloat(tok.slice(1));
      if (!(to > 0)) throw new Error(`bad wager token "${tok}"`);
      out.push(`${outstanding > 0 ? "Raise" : "Bet"}(${Math.round(to * 100)})`);
      outstanding = to;
    } else {
      throw new Error(`unknown token "${tok}"`);
    }
  }
  return out;
}
