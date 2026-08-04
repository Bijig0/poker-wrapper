/**
 * buildAnswerText
 * ----------------
 * Formats a GTO Wizard decision into a short, panel-ready line, e.g.
 * "FLOP — Check 76% · Bet 1.8 (33%) 7%". Frequencies are already percentages
 * (e.g. 76.2 meaning 76.2%), matching decideCombo's response shape.
 *
 * The decision's own action always leads; up to two other actions above a
 * noise floor are appended, sorted by frequency descending — enough to show
 * the strategy is mixed without turning the panel into a full strategy grid.
 */

export interface AnswerAction {
  action: string;
  frequency: number;
}

export interface AnswerInput {
  street: string;
  decision: { action: string; frequency?: number };
  actions?: AnswerAction[];
}

const NOISE_FLOOR_PCT = 5;
const MAX_ALTERNATIVES = 2;

const pct = (n: number): string => `${Math.round(n)}%`;

export const buildAnswerText = (input: AnswerInput): string => {
  const street = input.street.toUpperCase();
  const decisionFreq = input.decision.frequency;
  const head = `${input.decision.action}${decisionFreq != null ? ` ${pct(decisionFreq)}` : ""}`;

  const alternatives = (input.actions ?? [])
    .filter((a) => a.action !== input.decision.action && a.frequency > NOISE_FLOOR_PCT)
    .sort((a, b) => b.frequency - a.frequency)
    .slice(0, MAX_ALTERNATIVES)
    .map((a) => `${a.action} ${pct(a.frequency)}`);

  const line = [head, ...alternatives].join(" · ");
  return `${street} — ${line}`;
};
