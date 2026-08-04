/**
 * Parse a GTO Wizard action label into its kind, bb amount, and pot fraction.
 *
 * GTO Wizard renders bet labels in two orders depending on the solution set:
 *   - amount-first: "Bet 1.8 (33%)", "Allin 97 (1617%)"   (6-max General)
 *   - percent-first: "Bet 75% (18.75)", "Bet 75%"          (HU Complex)
 * The rule that disambiguates both: the number carrying "%" is the pot
 * fraction, the bare number is the bb amount.
 */
export interface BetLabel {
  kind: "check" | "call" | "fold" | "bet" | "raise" | "allin";
  /** Bet amount in bb, when the label includes one. */
  amount?: number;
  /** Size as % of pot, when the label includes one. */
  pct?: number;
}

export function parseBetLabel(label: string): BetLabel | null {
  const txt = (label ?? "").replace(/\s+/g, " ").trim();
  if (!txt) return null;

  const kindMatch = txt.match(/^(check|call|fold|bet|raise|allin)\b/i);
  if (!kindMatch) return null;
  const kind = kindMatch[1].toLowerCase() as BetLabel["kind"];
  if (kind === "check" || kind === "call" || kind === "fold") return { kind };

  const out: BetLabel = { kind };
  // numbers with an optional trailing %, in either order, with or without parens
  for (const m of txt.matchAll(/(\d+(?:\.\d+)?)\s*(%?)/g)) {
    const value = parseFloat(m[1]);
    if (m[2] === "%") {
      if (out.pct === undefined) out.pct = value;
    } else if (out.amount === undefined) {
      out.amount = value;
    }
  }
  if (out.amount === undefined && out.pct === undefined) return null;
  return out;
}
