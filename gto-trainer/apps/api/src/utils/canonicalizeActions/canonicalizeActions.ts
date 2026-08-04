/**
 * Canonicalize action labels by IDENTITY so distributions from different
 * nodes are comparable: bb amounts embedded in labels vary with the pot
 * ("Raise 13.75 (100%)" after a 50% bet vs "Raise 17.8 (100%)" after 75%),
 * but they are the same action — a pot-sized raise. Same-key frequencies
 * are summed.
 *
 *   Check / Call / Fold → as-is
 *   Allin …             → "All-in"
 *   Bet/Raise + pct     → "Bet 33%" / "Raise 100%"
 *   Bet/Raise, no pct   → "Bet 12bb" (preflop-style labels)
 */
import { parseBetLabel } from "../parseBetLabel/parseBetLabel";

export interface ActionFreq {
  action: string;
  frequency: number;
}

export function canonicalActionKey(label: string): string {
  const p = parseBetLabel(label);
  if (!p) return label.replace(/\s+/g, " ").trim();
  switch (p.kind) {
    case "check":
      return "Check";
    case "call":
      return "Call";
    case "fold":
      return "Fold";
    case "allin":
      return "All-in";
    default: {
      const verb = p.kind === "raise" ? "Raise" : "Bet";
      if (p.pct != null) return `${verb} ${p.pct}%`;
      if (p.amount != null) return `${verb} ${p.amount}bb`;
      return verb;
    }
  }
}

export function canonicalizeActions(actions: ActionFreq[]): ActionFreq[] {
  const merged = new Map<string, number>();
  for (const { action, frequency } of actions) {
    const key = canonicalActionKey(action);
    merged.set(key, (merged.get(key) ?? 0) + frequency);
  }
  return [...merged.entries()]
    .map(([action, frequency]) => ({ action, frequency: Math.round(frequency * 10) / 10 }))
    .sort((a, b) => b.frequency - a.frequency);
}
