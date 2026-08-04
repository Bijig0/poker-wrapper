/**
 * Resolve a user's shorthand for a bet-size action ("b75", "75", "check", "jam")
 * to one of the action labels scraped from GTO Wizard's strategy legend
 * (e.g. "Bet 75% (18.75)", "Check", "Allin 352% (88)").
 */
export const matchActionLabel = (query: string, labels: string[]): string | null => {
  const norm = (s: string) => s.toLowerCase().replace(/[\s%]+/g, "");
  const q = norm(query);
  if (!q) return null;

  const exact = labels.find((l) => norm(l) === q);
  if (exact) return exact;

  if (/^(x|check)$/.test(q)) return labels.find((l) => /^check/i.test(l)) ?? null;
  if (/^(jam|shove|allin|ai)$/.test(q)) return labels.find((l) => /^allin/i.test(l)) ?? null;

  // numeric pot-share: "75", "b75", "bet75" → the bet action with that % size
  const num = q.match(/^(?:b|bet)?(\d+(?:\.\d+)?)$/);
  if (num) {
    const size = num[1];
    return (
      labels.find((l) => new RegExp(`^bet\\s*${size}%`, "i").test(l)) ??
      labels.find((l) => norm(l).includes(size + "(")) ?? // e.g. allin sizes
      null
    );
  }

  // last resort: prefix of the normalized label ("bet7" → "Bet 75% …")
  return labels.find((l) => norm(l).startsWith(q)) ?? null;
};
