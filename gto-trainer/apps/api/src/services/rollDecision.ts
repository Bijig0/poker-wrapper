/**
 * rollDecision — ONE ROLL PER DECISION (2026-09-25, Brady).
 *
 * A mixed strategy is played by rolling a number and taking the action whose slice
 * of 0-100 it lands in. Every solve path already draws its own `decision` with
 * pickWeightedAction (a second, independent Math.random()), and the answer used to
 * be stitched from BOTH draws: the pick from the poller's roll, but the headline
 * action, the logged band, the chart/exploit columns — and, when the poller dropped
 * the drawn action as sub-1% noise, the pick itself — from the solver's. In
 * answers.sqlite that was 185 of 644 rolled answers headlining an action the roll did
 * not pick, 126 whose band did not contain the roll, and a 0.69% "BET 1.3" served
 * over "CHECK 99%" (2026-09-24).
 *
 * Here the solver's draw decides NOTHING but "is this piece pure": a decision at
 * >= 99% is the answer outright (the exploit overlays return their pick at 100% —
 * rolling over a mix there served the chart's action instead of the exploit's).
 * Everything else — pick, headline frequency, band, and the other piece's
 * would-have-picked — comes from the one roll, walked over the one set of bands
 * the integrity check also walks (answerIntegrity.rollBands).
 *
 * The roll is in (0, 100] to one decimal place: 1000 equally likely outcomes, so a
 * 63.4% action is played 63.4% of the time rather than 63%.
 */
import { bandForRoll, rollBands, type ActionFreq } from "./answerIntegrity";

export interface PieceDecision {
  action: string;
  frequency?: number | null;
}

export interface RolledPick {
  pick: string;
  /** the pick's own frequency in the mix it was served from — what the headline shows */
  frequency: number | null;
  /** null = pure: there was nothing to roll */
  roll: number | null;
  /** the pick's slice of the roll, [lo, hi] (a roll r lands on it when lo < r <= hi); [0, 100] when pure */
  band: [number, number];
}

/** A fresh roll: 0.1, 0.2, … 100.0, uniformly. */
export const drawRoll = (): number => (1 + Math.floor(Math.random() * 1000)) / 10;

/** One piece's pick for a given roll. `actions` is that piece's own mix. */
export function resolvePick(decision: PieceDecision, actions: ActionFreq[] | null | undefined, roll: number): RolledPick {
  const pure = (action: string, frequency: number | null): RolledPick => ({ pick: action, frequency, roll: null, band: [0, 100] });
  if ((decision.frequency ?? 0) >= 99) return pure(decision.action, decision.frequency ?? null);
  const bands = rollBands(actions ?? []);
  // no mix above the noise floor to roll over: the piece's own decision stands
  if (bands.length === 0) return pure(decision.action, decision.frequency ?? null);
  // one real action, the rest noise: that action IS the answer — never the solver's
  // draw, which may have landed on the noise (the 0.69% BET 1.3 above)
  if (bands.length === 1) return pure(bands[0]!.action, bands[0]!.frequency);
  const hit = bandForRoll(bands, roll)!;
  return { pick: hit.action, frequency: hit.frequency, roll, band: [hit.lo, hit.hi] };
}

export interface SolvedPieces {
  decision: PieceDecision;
  actions?: ActionFreq[] | null;
  exploitDecision?: PieceDecision | null;
  chartDecision?: PieceDecision | null;
  /** each piece's own mix when it is NOT the one that answered (fastSolve carries them) */
  chartActions?: ActionFreq[] | null;
  exploitActions?: ActionFreq[] | null;
}

export interface RolledDecision extends RolledPick {
  /** what the exploit / chart piece picks on this SAME roll (the served piece's is the pick) */
  exploitPick: string | null;
  chartPick: string | null;
}

/** The solve arrives over JSON, so "is this the served piece" is a value comparison. */
const same = (a: PieceDecision | null | undefined, b: PieceDecision | null | undefined): boolean =>
  !!a && !!b && JSON.stringify(a) === JSON.stringify(b);

/**
 * The whole decision from one roll. Pass the roll drawn for this decision (the
 * poller memoises it across re-solves); a fresh one is drawn when omitted.
 */
export function rollDecision(sol: SolvedPieces, roll: number = drawRoll()): RolledDecision {
  const served = resolvePick(sol.decision, sol.actions, roll);
  const servedIsExploit = same(sol.decision, sol.exploitDecision);
  const servedIsChart = !servedIsExploit && same(sol.decision, sol.chartDecision);
  // The piece that did not answer, on the same roll, over its own mix. Where a
  // solve path does not carry that mix, the piece's own decision stands.
  const exploitPick = servedIsExploit ? served.pick
    : sol.exploitDecision ? resolvePick(sol.exploitDecision, sol.exploitActions, roll).pick : null;
  const chartPick = servedIsChart ? served.pick
    : sol.chartDecision ? resolvePick(sol.chartDecision, sol.chartActions, roll).pick : null;
  return { ...served, exploitPick, chartPick };
}

/** The roll as the panel prints it: always one decimal ("roll 41.0 → FOLD"). */
export const fmtRoll = (roll: number): string => roll.toFixed(1);
