/**
 * Weighted random selection of a single action from a mixed strategy.
 *
 * This is how a mixed GTO strategy is actually executed: you can't play
 * "79% raise / 21% fold" on one hand, so you draw a random number and take
 * the action whose frequency band it lands in.
 *
 * `roll` is injectable in [0, 1) for testability; it defaults to Math.random().
 * Frequencies are treated as weights (they need not sum to exactly 100).
 */
export interface WeightedAction {
  action: string;
  frequency: number;
}

export interface WeightedPick {
  action: string;
  frequency: number;
  /** The draw expressed on the 0–100 scale, for display ("you rolled 41.3"). */
  roll: number;
  /** The chosen action's band on the 0–100 scale: [from, to). */
  band: [number, number];
}

export function pickWeightedAction(
  actions: WeightedAction[],
  roll: number = Math.random()
): WeightedPick | null {
  const positive = actions.filter((a) => a.frequency > 0);
  if (!positive.length) return null;

  const total = positive.reduce((sum, a) => sum + a.frequency, 0);
  const clamped = Math.min(Math.max(roll, 0), 0.999999999);
  const target = clamped * total;

  let from = 0;
  for (const a of positive) {
    const to = from + a.frequency;
    if (target < to) {
      const scale = 100 / total;
      return {
        action: a.action,
        frequency: a.frequency,
        roll: Math.round(target * scale * 10) / 10,
        band: [Math.round(from * scale * 10) / 10, Math.round(to * scale * 10) / 10],
      };
    }
    from = to;
  }
  // floating-point fallback: last action
  const last = positive[positive.length - 1];
  const scale = 100 / total;
  return {
    action: last.action,
    frequency: last.frequency,
    roll: Math.round(target * scale * 10) / 10,
    band: [Math.round((total - last.frequency) * scale * 10) / 10, 100],
  };
}
