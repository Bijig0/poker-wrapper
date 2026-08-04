/**
 * Parse the per-combo strategy rows from GTO Wizard's Hands aside panel.
 *
 * Each row is an action label followed by that combo's frequency in percent:
 *   "Bet 1.8 (33%) 0.4"  →  { action: "Bet 1.8 (33%)", frequency: 0.4 }
 *   "Check 99.6"         →  { action: "Check", frequency: 99.6 }
 * The frequency is always the LAST standalone number (no trailing % or
 * closing paren), so bet labels keep their size annotations intact.
 */
export interface ComboAction {
  action: string;
  frequency: number;
}

export function parseComboLegendRow(row: string): ComboAction | null {
  const txt = (row ?? "").replace(/\s+/g, " ").trim();
  if (!txt) return null;
  const m = txt.match(/^(.*?)\s+(\d+(?:\.\d+)?)$/);
  if (!m) return null;
  const action = m[1].trim();
  if (!action) return null;
  return { action, frequency: parseFloat(m[2]) };
}

/** Parse all rows, dropping unparseable ones, sorted by frequency desc. */
export function parseComboLegend(rows: string[]): ComboAction[] {
  return rows
    .map(parseComboLegendRow)
    .filter((r): r is ComboAction => r !== null)
    .sort((a, b) => b.frequency - a.frequency);
}
