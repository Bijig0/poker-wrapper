/**
 * Minimal extensive-form game interface for solver validation.
 *
 * Games are zero-sum: `utility(s)` is the payoff to player 0 at a terminal;
 * player 1 receives its negation. Chance nodes (card deals) are explicit.
 * This is deliberately tiny — it exists to host games with KNOWN equilibria
 * (Kuhn poker, the polar toy game) so the CFR + best-response machinery can be
 * checked against ground truth, then reused to measure any solver's output.
 */

export type Player = 0 | 1;

export interface Game<S> {
  root(): S;
  isChance(s: S): boolean;
  /** Chance outcomes with probabilities summing to 1 (only called on chance nodes). */
  chanceOutcomes(s: S): { prob: number; next: S }[];
  isTerminal(s: S): boolean;
  /** Payoff to player 0 (player 1 gets the negation). Only called on terminals. */
  utility(s: S): number;
  currentPlayer(s: S): Player;
  /** Information-set key for the acting player (hides opponent's private cards). */
  infoSet(s: S): string;
  actions(s: S): string[];
  play(s: S, action: string): S;
}

export interface InfoStrategy {
  actions: string[];
  probs: number[];
}

/** infoset key -> action distribution. */
export type AveragedStrategy = Map<string, InfoStrategy>;
