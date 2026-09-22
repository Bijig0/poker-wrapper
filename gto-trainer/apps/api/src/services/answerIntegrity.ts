/**
 * answerIntegrity — does an answer agree with its OWN evidence?
 *
 * Not "was the action right" (that is adherence, and a matter of strategy), but
 * the narrower, never-acceptable question: did we serve something the mix we
 * served it with does not support? Two ways that happens, both bugs:
 *
 *   served-off-mix  the action we picked is one its own strategy plays essentially
 *                   never. Seen live on 2026-09-14: SB 3d8d was served "Raise 2.5"
 *                   against a stored mix of "Fold 99.97%" — the pick came from the
 *                   pool-exploit piece while the mix came from the equilibrium
 *                   chart, so the answer and its evidence were from different
 *                   strategies. (The PICK was right there; the MIX was the wrong
 *                   artifact. That is why a fault is never a reason to withhold an
 *                   answer — it means the two disagree, not that the action is wrong.)
 *
 *   roll-mismatch   a mixed strategy was rolled, and the action the roll landed on
 *                   is not the action served. That is the roller or the mix being
 *                   wired wrongly, and it silently skews every mixed decision.
 *
 * THE FLOOR IS NOT ZERO. A solved chart carries numerical noise — the equilibrium
 * grid lists every action at 0.01% — so "is the action present in the mix" passes
 * on an action the strategy never plays, and misses exactly the fault above. The
 * test is the action's FREQUENCY against MIX_FLOOR_PCT, which is the same floor
 * services/studyPoller.ts rollAction uses to decide an action is real, so the
 * check and the roller agree on what "an action the strategy plays" means.
 */

export interface ActionFreq {
  action: string;
  frequency: number;
}

export type IntegrityKind = "served-off-mix" | "roll-mismatch";

export interface IntegrityFault {
  kind: IntegrityKind;
  /** Both kinds are bugs in the machine, never a judgement call about poker. */
  severity: "severe";
  /** One line, written for someone reading it in a table. */
  detail: string;
}

/** Below this, an action is noise in the solve rather than something the strategy plays. */
export const MIX_FLOOR_PCT = 1;

export interface AnswerToCheck {
  pick?: string | null;
  roll?: number | null;
  actions?: ActionFreq[] | null;
}

const norm = (s: string | null | undefined): string => (s ?? "").trim().toLowerCase().replace(/\s+/g, " ");

/** The mix entry for a label. Exact (normalised) match only: the pick and the mix
 *  come out of the same solve, so a near-match would be a DIFFERENT action — and
 *  fuzzy sizing would happily match "Raise 2.5" to "Raise 2.8" and hide the fault. */
const entryFor = (actions: ActionFreq[], label: string | null | undefined): ActionFreq | undefined =>
  actions.find((a) => norm(a.action) === norm(label));

/** Can this answer be checked at all? Answers logged before decision_json existed
 *  (before 2026-09-03) carry no mix, and must be reported as UNCHECKED rather than
 *  clean — a counter that calls them clean is claiming a guarantee it cannot make. */
export const isCheckable = (a: AnswerToCheck): boolean =>
  !!a.pick && Array.isArray(a.actions) && a.actions.length > 0;

/** The actions a strategy actually plays — the roller's own view of the mix. */
export const playedActions = (actions: ActionFreq[]): ActionFreq[] =>
  actions.filter((x) => (x.frequency ?? 0) > MIX_FLOOR_PCT);

/**
 * Which action a roll of 1..100 selects from a mix. Mirrors studyPoller.rollAction:
 * the sub-floor actions are dropped and the rest are normalised to 100, walked in
 * the order the solve listed them. Null when the mix is not one a roll decides.
 */
export function actionForRoll(actions: ActionFreq[], roll: number): string | null {
  const mix = playedActions(actions);
  if (mix.length < 2) return null;
  const total = mix.reduce((s, a) => s + a.frequency, 0);
  if (!(total > 0)) return null;
  let acc = 0;
  for (const a of mix) {
    acc += (a.frequency / total) * 100;
    if (roll <= acc) return a.action;
  }
  return mix[mix.length - 1]!.action;
}

/** Every integrity fault in one answer. Empty for a clean answer AND for one that
 *  cannot be checked — call isCheckable to tell those two apart. */
export function checkAnswerIntegrity(a: AnswerToCheck): IntegrityFault[] {
  if (!isCheckable(a)) return [];
  const actions = a.actions!;
  const faults: IntegrityFault[] = [];

  const mine = entryFor(actions, a.pick);
  const freq = mine?.frequency ?? null;
  if (freq == null || freq < MIX_FLOOR_PCT) {
    const top = [...actions].sort((x, y) => (y.frequency ?? 0) - (x.frequency ?? 0))[0];
    faults.push({
      kind: "served-off-mix",
      severity: "severe",
      detail: freq == null
        ? `served "${a.pick}", which is not in the mix it was served with (${top ? `${top.action} ${Math.round(top.frequency)}%` : "empty mix"})`
        : `served "${a.pick}", which this strategy plays ${freq}% of the time${top ? ` — it plays ${top.action} ${Math.round(top.frequency)}%` : ""}`,
    });
  }

  if (a.roll != null) {
    const landed = actionForRoll(actions, a.roll);
    if (landed != null && norm(landed) !== norm(a.pick)) {
      faults.push({
        kind: "roll-mismatch",
        severity: "severe",
        detail: `the roll of ${a.roll} lands on "${landed}", but "${a.pick}" was served`,
      });
    }
  }
  return faults;
}
